"""Read-only migration of the dated studies into one reviewable case contract.

No ranking, oracle, or historical artifact is changed by this migration.
"""
import gzip
import hashlib
import json
from collections import Counter
from datetime import datetime
from pathlib import Path

from .metrics import case_metrics, require, validate
from .native import verify_subset, vitest_records

APFD_COMMIT = 'c3a28ac84309d5df30d70c29ac60aefe92447ff5'
FUNCTION_COMMIT = 'd3e3811df4f23dc73de56a32728c044a3b7de6d5'
FEATURE_KEYS = ('id', 'path', 'bytes', 'duration', 'failed', 'known', 'testChanged', 'affected', 'coarseAffected')


def audit_timing(frozen_utc, execution):
    parse = lambda value: datetime.fromisoformat(value.replace('Z', '+00:00'))
    frozen, ended = parse(frozen_utc), parse(execution['endedUTC'])
    require(frozen <= ended, 'Feature freeze follows execution completion')
    started = execution.get('startedUTC')
    if started:
        require(frozen <= parse(started) <= ended, 'Feature freeze must precede execution start')
    return {'freezeBeforeStartVerified': bool(started),
            'basis': 'native-start-and-end' if started else 'legacy-end-only'}


class Importer:
    def __init__(self, root):
        self.root = root
        self.sources = {}

    def read(self, path):
        raw = path.read_bytes()
        self.sources[path.relative_to(self.root).as_posix()] = hashlib.sha256(raw).hexdigest()
        return json.loads(gzip.decompress(raw) if path.suffix == '.gz' else raw)

    def base(self, cohort, project, case, files, revealing, rank, model, commit):
        return {
            'schemaVersion': 1, 'cohort': cohort, 'project': project, 'case': case,
            'unit': 'test-file' if rank == 'native-serial' else 'java-class',
            'rankEvidence': rank, 'faultModel': model, 'implementationCommit': commit,
            'tests': [f['id'] for f in files], 'revealing': revealing,
            'features': [{k: f[k] for k in FEATURE_KEYS if k in f} for f in files],
            'policies': {}, 'fullPolicies': [],
        }

    def paper(self):
        root = self.root / 'greca22-all-subjects/persistent-analysis/evaluation'
        paths = sorted(root.glob('*/*/result.json'))
        require(len(paths) == 541, 'Expected the authoritative 541-case paper evaluation')
        cases = []
        for path in paths:
            row = self.read(path)
            require(row['status'] == 'evaluated', f'Unevaluated paper case: {path}')
            files = self.read(path.parent / 'features.json.gz')['files']
            orders = self.read(path.parent / 'frozen-orders.json')
            c = self.base('paper-java-file', row['project'], str(row['bug']), files,
                          row['faultIndices'], 'offline-replay', 'curated-trigger', APFD_COMMIT)
            c['partition'] = 'development' if row['project'] == 'Jsoup' else 'outside-jsoup'
            c['policies'] = {name: [orders[key]] for name, key in
                             [('FASTER APFD', 'order'), ('Previous FASTER', 'oldOrder'), ('Vitest base', 'baseline')]}
            c['fullPolicies'] = list(c['policies'])
            c['referenceMetrics'] = row['metrics']
            c['provenance'] = {'result': path.relative_to(self.root).as_posix(),
                               'recomputedPolicies': list(c['policies']),
                               'referenceOnlyPolicies': sorted(set(row['metrics']) - set(c['policies']))}
            # Full original stochastic permutations are not in this authoritative
            # directory. Keep published scores identified as reference evidence.
            self.check_reference(c, row['metrics'])
            cases.append(validate(c))
        return cases

    def java(self):
        method = self.root / 'faster-java-method-selection-20261021'
        ledger = self.read(method / 'ledger.json')
        require(len(ledger) == 17, 'Expected all 17 paired external Java faults')
        cases = []
        for row in ledger:
            require(row['status'] == 'evaluated', 'Unevaluated method case')
            name = 'faster-java-external-validation-20261010' if row['phase'] == 'Phase1' else 'faster-java-external-validation-20261020'
            old = self.root / name / 'results' / row['project'] / row['fixed'][:8]
            fine = method / 'results' / row['phase'] / row['project'] / row['fixed'][:8]
            files = self.read(old / 'features.json')['files']
            refined = self.read(fine / 'features.json')['files']
            require([f['id'] for f in files] == [f['id'] for f in refined], 'Java universe mismatch')
            for a, b in zip(files, refined):
                require({k: v for k, v in a.items() if k != 'affected'} ==
                        {k: v for k, v in b.items() if k != 'affected'}, 'Non-affected Java feature changed')
            orders = self.read(old / 'frozen-orders.json')
            method_order = self.read(fine / 'frozen-orders.json')['order']
            c = self.base('external-java-paired', row['project'], row['fixed'], files,
                          [i for i, f in enumerate(files) if f['id'] in row['faultClasses']],
                          'offline-replay', 'parent-production-fixed-tests', APFD_COMMIT)
            c['phase'] = row['phase']
            c['buggyParent'] = row['buggyParent']
            c['methodFeatures'] = [{k: f[k] for k in FEATURE_KEYS if k in f} for f in refined]
            c['policies'] = {name: [orders[key]] for name, key in
                             [('FASTER APFD', 'order'), ('Previous FASTER', 'oldOrder'), ('Vitest base', 'baseline')]}
            c['policies'].update(self.read(old / 'frozen-controls.json'))
            keep = lambda fs: {i for i, f in enumerate(fs) if f['failed'] or not f['known'] or f['testChanged'] or f['affected']}
            coarse_set, fine_set = keep(files), keep(refined)
            require(fine_set <= coarse_set, 'Method selection expands the paired universe')
            c['policies'].update({
                'FASTER method full': [method_order],
                'FASTER file selected': [[i for i in orders['order'] if i in coarse_set]],
                'FASTER method selected': [[i for i in method_order if i in fine_set]],
            })
            c['fullPolicies'] = ['FASTER APFD', 'Previous FASTER', 'Vitest base', 'FAST-pw', 'Random', 'FASTER method full']
            result = self.read(old / 'result.json')
            c['referenceMetrics'] = result['metrics']
            c['provenance'] = {'result': (old / 'result.json').relative_to(self.root).as_posix(),
                               'methodResult': (fine / 'result.json').relative_to(self.root).as_posix(),
                               'nativeSubsetValidation': row['validation']}
            oracle = self.read(old / result.get('repairedEvidenceRoot', 'repaired') / 'run1/records.json')
            control = self.read(old / 'fixed/records.json')
            c['provenance']['reimportedNativeAudit'] = {
                label: verify_subset(oracle, self.read(fine / ('native-' + label) / 'records.json'),
                                     [files[i]['id'] for i in selected], control)
                for label, selected in [('file', coarse_set), ('method', fine_set)]}
            self.read(fine / 'freeze-seal.json')
            self.check_reference(c, result['metrics'])
            computed = case_metrics(c)
            for label, key in [('FASTER APFD', 'fileFull'), ('FASTER method full', 'methodFull'),
                               ('FASTER file selected', 'fileSelected'), ('FASTER method selected', 'methodSelected')]:
                require(abs(computed[label]['APFDf'] - row['metrics'][key]['APFDf']) < 1e-12, 'Method metric drift')
            cases.append(validate(c))
        return cases

    def javascript(self):
        root = self.root / 'faster-function-selection-20261021'
        summary = self.read(root / 'summary.json')
        require(not summary['errors'] and len(summary['primaryCases']) == 18, 'Unvalidated JavaScript cohort')
        cases = []
        for row in summary['primaryCases']:
            dest = root / 'runs' / row['project'] / row['case']
            f = self.read(dest / 'features/features.json')
            files = f['files']
            ids = [v['id'] for v in files]
            result = self.read(root / 'results' / row['project'] / (row['case'] + '.json'))
            c = self.base('javascript-paired', row['project'], row['case'], files,
                          [ids.index(v) for v in result['originalRevealingFiles']],
                          'native-serial', 'seeded-ast-mutation', FUNCTION_COMMIT)
            c['mutation'] = result['mutation']
            c['policies'] = {}
            original = self.root / 'faster-external-validation-20261009/runs' / row['project']
            oracle = vitest_records(self.read(original / row['case'] / 'apfd/execution.json'))
            attempt = next(i + 1 for i, trial in enumerate(result['control']['attempts']) if trial['passes'])
            control_case = 'control-' + result['mutation']['revision'][:12] + '-' + str(attempt)
            control = vitest_records(self.read(root / 'runs' / row['project'] / control_case / 'warm/execution.json'))
            timing, native = {}, {}
            for label, subdir, selected, expected_rank in [
                ('FASTER file selected', 'baseline-selected', f['baselineSelected'], row['coarseRank']),
                ('FASTER function selected', 'selected', f['selected'], row['functionRank']),
            ]:
                execution = self.read(dest / subdir / 'execution.json')
                require(not execution['errors'], 'Native JavaScript run has unhandled errors')
                require(set(execution['order']) == set(selected), 'Native selection mismatch')
                timing[label] = audit_timing(f['frozenUTC'], execution)
                native[label] = verify_subset(oracle, vitest_records(execution), selected, control)
                c['policies'][label] = [[ids.index(v) for v in execution['order']]]
                require(case_metrics(c)[label]['meanFirstFailureRankWhenDetected'] == expected_rank, 'Native rank drift')
            require(row['allOriginalFaultIdentitiesRetained'] and row['matchingSelectedMethodMembership'], 'Fault identity validation missing')
            c['provenance'] = {'result': (root / 'results' / row['project'] / (row['case'] + '.json')).relative_to(self.root).as_posix(),
                               'membershipAndFailureIdentityAudit': 'faster-function-selection-20261021/scripts/analyze.py',
                               'reimportedNativeAudit': native, 'timingAudit': timing,
                               'developmentCohort': True}
            cases.append(validate(c))
        return cases

    def attempts(self):
        rows = []
        keys = ('project', 'fixed', 'buggyParent', 'case', 'date', 'message', 'issue', 'status', 'reason')
        for name in ['faster-java-external-validation-20261010', 'faster-java-external-validation-20261020',
                     'faster-java-dbutils-validation-20261020']:
            for row in self.read(self.root / name / 'ledger.json'):
                item = {k: row[k] for k in keys if k in row}
                # Preserve the reason, with portable evidence-relative paths.
                if 'reason' in item:
                    item['reason'] = item['reason'].replace(str(self.root) + '/', '')
                rows.append({'cohort': 'external-java-search', 'phase': name, **item})
        old = self.root / 'faster-external-validation-20261009/results'
        for path in sorted(old.glob('*/*.json')):
            row = self.read(path)
            if row.get('kind') != 'production-mutation':
                continue
            item = {k: row[k] for k in keys if k in row}
            item['reason'] = str(item.get('reason', '')).replace(str(self.root) + '/', '')
            replay = self.read(self.root / 'faster-function-selection-20261021/results' / row['project'] / (row['case'] + '.json'))
            rows.append({'cohort': 'javascript-mutation-search', **item, 'granularityReplayStatus': replay['status']})
        require(sum(r['cohort'] == 'external-java-search' for r in rows) == 31, 'Java attempt count drift')
        require(sum(r['cohort'] == 'javascript-mutation-search' for r in rows) == 72, 'JavaScript attempt count drift')
        return rows

    @staticmethod
    def check_reference(case, reference):
        for name, actual in case_metrics(case).items():
            if name in reference:
                require(abs(actual['APFDf'] - reference[name]['APFDf']) < 1e-12, f'{name}: historical APFDf drift')


def import_evidence(root, destination):
    importer = Importer(root)
    cases = importer.paper() + importer.java() + importer.javascript()
    payload = ''.join(json.dumps(c, separators=(',', ':'), allow_nan=False) + '\n' for c in cases).encode()
    destination.mkdir(parents=True, exist_ok=True)
    # Fixed gzip timestamp makes independent imports byte-for-byte comparable.
    blob = gzip.compress(payload, mtime=0)
    (destination / 'cases.jsonl.gz').write_bytes(blob)
    attempts = (json.dumps(importer.attempts(), indent=2) + '\n').encode()
    (destination / 'attempts.json').write_bytes(attempts)
    manifest = {
        'schemaVersion': 1, 'caseCount': len(cases),
        'casesSHA256': hashlib.sha256(blob).hexdigest(),
        'attemptsSHA256': hashlib.sha256(attempts).hexdigest(),
        'cohortCounts': dict(Counter(c['cohort'] for c in cases)),
        'sources': dict(sorted(importer.sources.items())),
        'qualification': 'Portable derived records, not raw native evidence. Source hashes refer to the original outputs directory. No test source, dependency cache, jar, or project checkout is redistributed.',
    }
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'cases': len(cases), 'bytes': len(blob), 'sources': len(importer.sources)}, indent=2))
