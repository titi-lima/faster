#!/usr/bin/env python3
"""Fetch the pinned subjects, execute the 35 recorded faults, and report results."""
import argparse
import gzip
import hashlib
import io
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import tarfile
from datetime import datetime, timezone
from pathlib import Path

from benchmark.metrics import case_metrics, compare, require, summarize
from benchmark.native import outcomes, verify_subset, vitest_records
from benchmark.import_evidence import audit_timing
from adapters.java import replay as java_replay
from adapters.surefire import read_reports

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + '\n')


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def failures(records):
    return sorted([unit, test['id']] for unit, row in records.items()
                  for test in row['tests'] if test['state'] == 'fail')


def input_hashes(work):
    files = [p for name in ['src', 'packages'] for p in (work / name).rglob('*')
             if p.is_file() and not {'node_modules', 'target', '.study-cache'} & set(p.relative_to(work).parts)]
    files += [work / name for name in ['pom.xml', 'package.json'] if (work / name).exists()]
    return {str(p.relative_to(work)): sha(p) for p in sorted(files)}


def load_plan():
    data = ROOT / 'data'
    plan = read(data / 'replication.json')
    require(sha(data / 'replication.json') == read(data / 'manifest.json')['replicationSHA256'], 'Replication plan fingerprint differs')
    require(sha(data / 'cases.jsonl.gz') == plan['datasetSHA256'], 'Replication plan dataset differs')
    cases = [json.loads(s) for s in gzip.decompress((data / 'cases.jsonl.gz').read_bytes()).decode().splitlines()]
    identities = [(s['project'], s['case']) for s in plan['cases']]
    require(len(identities) == len(set(identities)) == len(cases), 'Duplicate or missing replication case')
    require(set(identities) == {(c['project'], c['case']) for c in cases}, 'Replication case identities differ')
    require(set(plan['subjects']) == {c['project'] for c in cases}, 'Replication subjects differ')
    require(sha(data / 'replication-inputs.jsonl.gz') == plan['inputsSHA256'], 'Replication inputs fingerprint differs')
    inputs = [json.loads(s) for s in gzip.decompress((data / 'replication-inputs.jsonl.gz').read_bytes()).decode().splitlines()]
    index = {(s['project'], s['case']): s for s in inputs}
    require(len(index) == len(inputs) == len(identities) and set(index) == set(identities), 'Replication inputs case identities differ')
    for spec in plan['cases']:
        spec.update(index[spec['project'], spec['case']])
    for name, expected in plan['runtimeSHA256'].items():
        require(sha(ROOT / 'runtime' / name) == expected, 'Runtime fingerprint differs: ' + name)
    return plan, {(c['project'], c['case']): c for c in cases}


def mutate(checkout, mutation):
    path = (checkout / mutation['path']).resolve()
    require(path.is_relative_to(checkout.resolve()), 'Mutation path escapes checkout')
    require(sha(path) == mutation['sourceSHA256'], 'Mutation source differs from pinned source')
    source = path.read_text()
    offset, before = mutation['offset'], mutation['before']
    require(source[offset:offset + len(before)] == before, 'Mutation site differs')
    updated = source[:offset] + mutation['after'] + source[offset + len(before):]
    require(hashlib.sha256(updated.encode()).hexdigest() == mutation['mutatedSHA256'], 'Mutation result differs')
    path.write_text(updated)


class Run:
    def __init__(self, args, plan):
        self.args, self.plan, self.out = args, plan, args.out.resolve()
        self.env = {**os.environ, 'CI': 'true', 'TZ': 'UTC', 'NO_COLOR': '1'}
        self.env.pop('JAVA_TOOL_OPTIONS', None)
        if args.java_home:
            self.env.update(JAVA_HOME=str(args.java_home.resolve()),
                            PATH=str(args.java_home.resolve() / 'bin') + os.pathsep + self.env['PATH'])
        self.env['MAVEN_OPTS'] = '-Xmx2g -Duser.language=en -Duser.country=US'

    def command(self, args, cwd, log, allowed=(0,), env=None, timeout=1200):
        log.parent.mkdir(parents=True, exist_ok=True)
        started = datetime.now(timezone.utc).isoformat()
        with log.open('w') as stream:
            process = subprocess.Popen(list(map(str, args)), cwd=cwd, env=env or self.env,
                                       stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
            try:
                code = process.wait(timeout=timeout)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                raise
        write(log.with_suffix('.process.json'), {'command': list(map(str, args)), 'exitCode': code,
              'startedUTC': started, 'endedUTC': datetime.now(timezone.utc).isoformat()})
        require(code in allowed, f'Command exited {code}; see {log}')
        return log.read_text()

    def checkout(self, project, revision, destination):
        mirror = self.out / 'repos' / (project + '.git')
        if not mirror.exists():
            self.command(['git', 'init', '--bare', mirror], REPO, self.out / 'logs' / (project + '-init.log'))
            self.command(['git', '--git-dir', mirror, 'remote', 'add', 'origin',
                          self.plan['subjects'][project]['repository']], REPO, self.out / 'logs' / (project + '-remote.log'))
        self.command(['git', '--git-dir', mirror, 'fetch', '--depth=1', '--no-tags', 'origin', revision],
                     REPO, self.out / 'logs' / (project + '-' + revision[:12] + '.log'))
        archive = subprocess.check_output(['git', '--git-dir', str(mirror), 'archive', revision], env=self.env)
        require(destination.resolve().is_relative_to(self.out), 'Checkout outside run directory')
        if destination.exists():
            shutil.rmtree(destination)
        destination.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(destination, filter='data')
        write(destination.parent / (destination.name + '-checkout.json'),
              {'revision': revision, 'archiveSHA256': hashlib.sha256(archive).hexdigest()})

    def java_tests(self, work, output, selected=None, coverage=None):
        flags = '-Duser.language=en -Duser.country=US'
        if coverage:
            coverage.mkdir(parents=True, exist_ok=True)
            agent = self.out / 'm2/org/jacoco/org.jacoco.agent/0.8.4/org.jacoco.agent-0.8.4-runtime.jar'
            flags += f' -javaagent:{agent}=output=none,dumponexit=false,includes=org.apache.commons.*:com.squareup.javapoet.*:com.fasterxml.jackson.*'
            flags += f' -javaagent:{self.out / "java-tools/scope-agent.jar"}={coverage}'
        command = [self.args.maven, '-B', '-ntp', '-s', self.out / 'settings.xml',
                   '-Dmaven.repo.local=' + str(self.out / 'm2'), '-Dmaven.test.failure.ignore=true',
                   '-Dcheckstyle.skip=true', '-Drat.skip=true', '-Duser.language=en', '-Duser.country=US',
                   '-DargLine=' + flags, 'clean', 'test']
        if selected is not None:
            require(bool(selected), 'Use an explicit empty subset, never Maven with an empty -Dtest')
            command.append('-Dtest=' + ','.join(selected))
        self.command(command, work, output / 'maven.log')
        reports = work / 'target/surefire-reports'
        records = read_reports(reports)
        shutil.copytree(reports, output / 'xml')
        write(output / 'records.json', records)
        return records

    def java_checkout(self, spec, revision, work):
        self.checkout(spec['project'], revision, work)
        pom = work / 'pom.xml'
        text = pom.read_text()
        if spec['project'] == 'jackson-core' and '<version>2.10.0-SNAPSHOT</version>' in text.split('</parent>')[0]:
            text = text.replace('<version>2.10.0-SNAPSHOT</version>', '<version>2.10.0</version>', 1)
        if spec['project'] == 'commons-io':
            text = re.sub(r'<argLine>([\s\S]*?)</argLine>', lambda m: m.group(0) if '${argLine}' in m[1]
                          else '<argLine>' + m[1] + ' ${argLine}</argLine>', text)
        pom.write_text(text)

    def java(self, case, spec, output):
        work = output / 'checkout'
        self.java_checkout(spec, spec['revision'], work)
        for feature in case['features']:
            require((work / feature['path']).stat().st_size == feature['bytes'], 'Test source size differs')
        fresh_features = java_replay.features(self, case, spec, output, read, write)
        write(output / 'features.json', {'files': fresh_features})
        self.command(['node', '--import', 'tsx', ROOT / 'adapters/order.ts',
                      output / 'features.json', output / 'orders.json'], REPO, output / 'order.log')
        frozen = read(output / 'orders.json')
        selected = [case['tests'][i] for i in frozen['selectedOrder']]
        control = self.java_tests(work, output / 'control')
        self.java_checkout(spec, spec['parent'], work)
        test_tree = self.out / 'repos' / (spec['project'] + '.git')
        archive = subprocess.check_output(['git', '--git-dir', str(test_tree), 'archive', spec['revision'], 'src/test'])
        shutil.rmtree(work / 'src/test')
        with tarfile.open(fileobj=io.BytesIO(archive)) as source:
            source.extractall(work, filter='data')
        inputs = input_hashes(work)
        write(output / 'input-sources.json', inputs)
        oracle = self.java_tests(work, output / 'oracle')
        repeat = self.java_tests(work, output / 'repeat')
        require(outcomes(oracle) == outcomes(repeat), 'Full fault outcomes are unstable')
        require({u for u, r in oracle.items() if r['runCount']} == set(case['tests']), 'Java test universe changed')
        subset = self.java_tests(work, output / 'selected', selected) if selected else {}
        require(input_hashes(work) == inputs, 'Subject sources changed during native execution')
        audit = verify_subset(oracle, subset, selected, control)
        timing = audit_timing(frozen['frozenUTC'], read(output / 'oracle/maven.process.json'))
        require(failures(oracle) == spec['failingMethods'], 'Target fault identities changed')
        policies = {**case['policies'], 'FASTER': [frozen['selectedOrder']], 'FASTER full': [frozen['order']]}
        return {**case, 'features': fresh_features, 'policies': policies}, {'subset': audit,
                'features': 'fresh historical method coverage; recorded dependency observations and durations',
                'baselineOrders': 'recorded', 'rankEvidence': 'offline-replay', 'frozenUTC': frozen['frozenUTC'],
                'timing': timing, 'inputSourcesSHA256': sha(output / 'input-sources.json')}

    def javascript_run(self, spec, work, output, phase):
        env = {**self.env, 'FASTER_REPLICATION_ROOT': str(work), 'FASTER_REPLICATION_PROJECT': spec['project'],
               'FASTER_REPLICATION_PHASE': phase, 'FASTER_RESEARCH_OUTPUT': str(output / 'execution.json')}
        if phase == 'features':
            command = ['node', '--import', 'tsx', ROOT / 'adapters/vitest-replay.ts']
        else:
            command = ['node', REPO / 'packages/faster/faster.mjs', 'run', '--root', work,
                       '--config', ROOT / 'adapters/vitest.config.ts']
        self.command(command, REPO, output / 'cli.log', allowed=(0, 1) if phase != 'features' else (0,), env=env)
        return read(output / ('features.json' if phase == 'features' else 'execution.json'))

    def javascript(self, case, spec, output):
        work = output / 'checkout'
        self.checkout(spec['project'], spec['revision'], work)
        (work / 'node_modules').symlink_to(self.out / 'runtime/node_modules', target_is_directory=True)
        control = vitest_records(self.javascript_run(spec, work, output / 'control', 'control'))
        require(not failures(control), 'Unmodified JavaScript control fails')
        cache = work / '.study-cache'
        caches = list(cache.rglob('results.json'))
        require(len(caches) == 1, 'Missing or ambiguous prior results cache')
        results = read(caches[0])
        for key, value in results['results']:
            identity = key.split(':', 1)[1]
            require(identity in spec['durations'], 'Unrecorded historical test duration')
            value['duration'] = spec['durations'][identity]
        write(caches[0], results)
        shutil.copytree(cache, output / 'prior-cache')
        mutate(work, spec['mutation'])
        inputs = input_hashes(work)
        write(output / 'input-sources.json', inputs)
        frozen = self.javascript_run(spec, work, output / 'features', 'features')
        require([f['id'] for f in frozen['files']] == case['tests'], 'JavaScript test universe changed')
        executions = {}
        for phase in ['full', 'base', 'selected']:
            shutil.rmtree(cache)
            shutil.copytree(output / 'prior-cache', cache)
            executions[phase] = self.javascript_run(spec, work, output / phase, phase)
        oracle, repeat, subset = [vitest_records(executions[p]) for p in ['full', 'base', 'selected']]
        require(input_hashes(work) == inputs, 'Subject sources changed during native execution')
        require(outcomes(oracle) == outcomes(repeat), 'Full fault outcomes are unstable')
        require(failures(oracle) == spec['failingMethods'], 'Target fault identities changed')
        audit = verify_subset(oracle, subset, frozen['selected'], control)
        timing = audit_timing(frozen['frozenUTC'], executions['full'])
        require(executions['selected']['order'] == frozen['selectedOrder'], 'Selected execution differs from frozen order')
        require(executions['full']['order'] == frozen['fullOrder'], 'Full execution differs from frozen order')
        policies = {name: [[case['tests'].index(i) for i in executions[phase]['order']]]
                    for name, phase in [('FASTER', 'selected'), ('FASTER full', 'full'), ('Vitest base', 'base')]}
        return {**case, 'features': frozen['files'], 'policies': policies, 'fullPolicies': ['FASTER full', 'Vitest base']}, {
            'subset': audit, 'features': 'fresh passing-control coverage; recorded prior durations',
            'rankEvidence': 'native-serial', 'frozenUTC': frozen['frozenUTC'], 'timing': timing,
            'inputSourcesSHA256': sha(output / 'input-sources.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, default=ROOT / 'work/replication')
    parser.add_argument('--project', help='Run one of the seven projects')
    parser.add_argument('--case', help='Run one case (commit or mutation ID prefix)')
    parser.add_argument('--java-home', type=Path, default=os.environ.get('JAVA_HOME'))
    parser.add_argument('--maven', default=os.environ.get('MVN', 'mvn'))
    parser.add_argument('--list', action='store_true', help='List cases without fetching or executing anything')
    args = parser.parse_args()
    plan, cases = load_plan()
    specs = [s for s in plan['cases'] if (not args.project or s['project'] == args.project)
             and (not args.case or s['case'].startswith(args.case))]
    require(bool(specs), 'No cases match the filter')
    if args.list:
        print('\n'.join(f"{s['project']} {s['case']}" for s in specs))
        return
    require(sys.version_info >= (3, 12), 'Native replication requires Python 3.12+')
    require(not args.out.exists(), f'Use a fresh --out directory: {args.out}')
    destination = args.out.resolve()
    require(not destination.is_relative_to(REPO) or any(destination.is_relative_to(ROOT / p) for p in ['work', 'artifacts']),
            'Inside this repository, put generated runs under research/work/ or research/artifacts/')
    require((REPO / 'packages/faster/faster.mjs').exists(), 'Run pnpm install --frozen-lockfile and pnpm build first')
    runner = Run(args, plan)
    if any(s['cohort'] == 'java' for s in specs):
        require(args.java_home is not None, 'Supply --java-home /path/to/jdk8 (or JAVA_HOME)')
        require((args.java_home / 'bin/java').exists(), 'JDK executable does not exist')
        require(shutil.which(args.maven), 'Maven executable does not exist; supply --maven /path/to/mvn')
    require(shutil.which('node') and shutil.which('pnpm') and shutil.which('git'), 'Put Node 24, pnpm 10 and Git on PATH')
    version = subprocess.check_output(['node', '--version'], text=True).strip()
    require(version.startswith('v24.'), 'Use Node 24 for this replication')
    runner.out.mkdir(parents=True)
    if any(s['cohort'] == 'java' for s in specs):
        require(args.java_home is not None, 'Supply --java-home /path/to/jdk8 (or JAVA_HOME)')
        version = runner.command([args.java_home / 'bin/java', '-version'], REPO, runner.out / 'java-version.log')
        require('"1.8.' in version, 'The pinned Java subjects require JDK 8')
        version = runner.command([args.maven, '-version'], REPO, runner.out / 'maven-version.log')
        require('Apache Maven 3.9.9' in version, 'Use Maven 3.9.9')
        (runner.out / 'settings.xml').write_text('<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"/>\n')
        java_replay.prepare(runner, read)
    if any(s['cohort'] == 'javascript' for s in specs):
        shutil.copytree(ROOT / 'runtime', runner.out / 'runtime')
        runner.command(['pnpm', 'install', '--ignore-workspace', '--frozen-lockfile'],
                       runner.out / 'runtime', runner.out / 'runtime-install.log')
    source_hashes = {str(p.relative_to(REPO)): sha(p) for p in [ROOT / 'data/replication.json', ROOT / 'data/replication-inputs.jsonl.gz',
                     ROOT / 'data/cases.jsonl.gz', ROOT / 'data/manifest.json', ROOT / 'replicate.py',
                     *sorted((ROOT / 'adapters').rglob('*')), *sorted((ROOT / 'runtime').iterdir()),
                     *sorted((ROOT / 'benchmark').glob('*.py')),
                     *[REPO / p for p in read(ROOT / 'core-map.json')['files']]] if p.is_file() and '__pycache__' not in p.parts}
    run_info = {'requestedCases': len(specs), 'startedUTC': datetime.now(timezone.utc).isoformat(),
          'sourceSHA256': source_hashes, 'featureProtocol': 'Fresh method/function coverage and native executions; recorded Java dependency observations, durations and baseline permutations',
          'implementationCommit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip(),
          'node': version}
    write(runner.out / 'run.json', run_info)
    ledger, completed = [], []
    for i, spec in enumerate(specs, 1):
        print(f"[{i}/{len(specs)}] {spec['project']} {spec['case']}", flush=True)
        output = runner.out / 'cases' / spec['project'] / spec['case']
        output.mkdir(parents=True)
        case = cases[spec['project'], spec['case']]
        try:
            result, audit = getattr(runner, spec['cohort'])(case, spec, output)
            write(output / 'case.json', result)
            write(output / 'audit.json', audit)
            write(output / 'metrics.json', {'recorded': case_metrics(case), 'reproduced': case_metrics(result)})
            completed.append(result)
            row = {'project': spec['project'], 'case': spec['case'], 'status': 'completed'}
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            row = {'project': spec['project'], 'case': spec['case'], 'status': 'blocked', 'reason': str(error)}
        ledger.append(row)
        write(runner.out / 'ledger.json', ledger)
        print('  ' + row['status'] + (': ' + row['reason'] if 'reason' in row else ''), flush=True)
    require(all(sha(REPO / p) == value for p, value in source_hashes.items()), 'Replication implementation changed during execution')
    write(runner.out / 'summary.json', {'complete': len(completed) == len(specs), 'requested': len(specs),
          'completed': len(completed), 'results': summarize(completed) if len(completed) == len(specs) else []})
    if len(completed) != len(specs):
        raise SystemExit('Replication incomplete; inspect ledger.json. Aggregate results are withheld.')
    comparisons = []
    for cohort in sorted({c['cohort'] for c in completed}):
        group = [c for c in completed if c['cohort'] == cohort]
        for policy in sorted(set.intersection(*(set(c['policies']) for c in group)) - {'FASTER'}):
            comparisons.append({'cohort': cohort, **compare(group, 'FASTER', policy)})
    write(runner.out / 'comparisons.json', comparisons)
    write(runner.out / 'run.json', {**run_info, 'complete': True, 'endedUTC': datetime.now(timezone.utc).isoformat()})
    print(f'Replication complete: {len(completed)} cases. Reports: {runner.out}', flush=True)


if __name__ == '__main__':
    main()
