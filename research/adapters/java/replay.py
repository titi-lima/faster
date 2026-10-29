"""Collect method models and suite coverage at the recorded history revisions."""
import hashlib
import os
from pathlib import Path
from urllib.request import urlopen

from .refine import refine, scope_for


def prepare(run, read):
    root = Path(__file__).resolve().parent
    for relative, expected in read(root / 'dependencies.json').items():
        path = run.out / 'm2' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists():
            with urlopen('https://repo.maven.apache.org/maven2/' + relative, timeout=120) as response:
                path.write_bytes(response.read())
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError('Java dependency fingerprint differs: ' + relative)
    run.command(['python3', root / 'build.py', '--m2', run.out / 'm2', '--java-home', run.args.java_home,
                 '--out', run.out / 'java-tools'], run.out, run.out / 'java-tools/build.log')


def collect(run, spec, revision, read, write):
    dest = run.out / 'coverage' / spec['project'] / revision
    if (dest / 'coverage.json').exists():
        return dest
    print(f"  coverage {spec['project']} {revision[:12]}", flush=True)
    work = dest / 'checkout'
    run.java_checkout(spec, revision, work)
    records = run.java_tests(work, dest / 'control', coverage=dest / 'exec')
    if any(t['state'] == 'fail' for r in records.values() for t in r['tests']):
        raise ValueError('Instrumented historical control fails: ' + revision)
    if list((dest / 'exec').glob('transform-error-*.txt')):
        raise ValueError('Coverage instrumentation failed: ' + revision)
    scopes = {p.name.split('--')[0] for p in (dest / 'exec').glob('*.exec')}
    if not {u for u, r in records.items() if r['runCount']} <= scopes:
        raise ValueError('Missing native suite coverage: ' + revision)
    classpath = (run.out / 'java-tools/classpath.txt').read_text().strip()
    classes = os.pathsep.join(str(work / p) for p in ['target/classes', 'target/test-classes'])
    java = run.args.java_home / 'bin/java'
    model = {}
    text = run.command([java, '-cp', classpath, 'Analyze', 'model', classes], work, dest / 'model.tsv')
    for line in text.splitlines():
        fields = line.split('\t')
        row = model.setdefault(fields[1], {'methods': {}})
        if fields[0] == 'SHELL':
            row['shell'] = fields[2]
        else:
            row['methods'][fields[2]] = fields[3]
    coverage = {}
    text = run.command([java, '-cp', classpath, 'Analyze', 'coverage', classes, dest / 'exec'], work, dest / 'coverage.tsv')
    for line in text.splitlines():
        suite, cls, method = line.split('\t')
        coverage.setdefault(suite, {}).setdefault(cls, set()).add(method)
    for path in (dest / 'exec').glob('initialization-*.tsv'):
        for line in path.read_text().splitlines():
            cls, method = line.split('\t')
            coverage.setdefault('__GLOBAL__', {}).setdefault(cls, set()).add(method)
    write(dest / 'model.json', model)
    write(dest / 'coverage.json', {t: {c: sorted(ms) for c, ms in cs.items()} for t, cs in coverage.items()})
    return dest


def features(run, case, spec, output, read, write):
    current = collect(run, spec, spec['revision'], read, write)
    model = read(current / 'model.json')
    result, decisions = [], []
    for feature in case['features']:
        original = {**feature, **spec['dependencies'][feature['id']]}
        revision = spec['priors'].get(feature['id'])
        if revision:
            prior = collect(run, spec, revision, read, write)
            affected, reasons = refine(original, read(prior / 'model.json'), model,
                                       scope_for(read(prior / 'coverage.json'), feature['id']))
        else:
            affected, reasons = original['affected'], []
        result.append({**feature, 'affected': affected})
        decisions.append({'id': feature['id'], 'affected': affected, 'reasons': reasons})
    write(output / 'decisions.json', decisions)
    return result
