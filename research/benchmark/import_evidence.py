"""Import the current strategy's recorded Java and JavaScript experiments."""
import gzip
import hashlib
import json
from collections import Counter
from datetime import datetime

from .metrics import case_metrics, require, validate
from .native import verify_subset, vitest_records

FEATURE_KEYS = ('id', 'path', 'bytes', 'duration', 'failed', 'known', 'testChanged', 'affected')


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
        self.root, self.sources = root, {}

    def read(self, path):
        raw = path.read_bytes()
        self.sources[path.relative_to(self.root).as_posix()] = hashlib.sha256(raw).hexdigest()
        return json.loads(raw)

    @staticmethod
    def case(cohort, project, identity, files, revealing, rank, model, commit):
        return {'schemaVersion': 1, 'cohort': cohort, 'project': project, 'case': identity,
                'unit': 'test-file' if cohort == 'javascript' else 'java-class',
                'rankEvidence': rank, 'faultModel': model, 'implementationCommit': commit,
                'tests': [f['id'] for f in files], 'revealing': revealing,
                'features': [{k: f[k] for k in FEATURE_KEYS if k in f} for f in files],
                'policies': {}, 'fullPolicies': []}

    def java(self):
        root = self.root / 'faster-java-method-selection-20261021'
        cases = []
        for row in self.read(root / 'ledger.json'):
            require(row['status'] == 'evaluated', 'Unevaluated Java case')
            origin = 'faster-java-external-validation-20261010' if row['phase'] == 'Phase1' else 'faster-java-external-validation-20261020'
            original = self.root / origin / 'results' / row['project'] / row['fixed'][:8]
            current = root / 'results' / row['phase'] / row['project'] / row['fixed'][:8]
            files = self.read(current / 'features.json')['files']
            order = self.read(current / 'frozen-orders.json')['order']
            selected = {i for i, f in enumerate(files) if f['failed'] or not f['known'] or f['testChanged'] or f['affected']}
            c = self.case('java', row['project'], row['fixed'], files,
                          [i for i, f in enumerate(files) if f['id'] in row['faultClasses']],
                          'offline-replay', 'parent-production-fixed-tests',
                          'c3a28ac84309d5df30d70c29ac60aefe92447ff5')
            c['policies'] = {'FASTER': [[i for i in order if i in selected]], 'FASTER full': [order],
                             'Vitest base': [self.read(original / 'frozen-orders.json')['baseline']],
                             **self.read(original / 'frozen-controls.json')}
            c['fullPolicies'] = ['FASTER full', 'Vitest base', 'FAST-pw', 'Random']
            result = self.read(original / 'result.json')
            oracle = self.read(original / result.get('repairedEvidenceRoot', 'repaired') / 'run1/records.json')
            audit = verify_subset(oracle, self.read(current / 'native-method/records.json'),
                                  [files[i]['id'] for i in selected], self.read(original / 'fixed/records.json'))
            c['provenance'] = {'result': (current / 'result.json').relative_to(self.root).as_posix(), 'nativeAudit': audit}
            require(abs(case_metrics(c)['FASTER']['APFDf'] - row['metrics']['methodSelected']['APFDf']) < 1e-12, 'Recorded Java score changed')
            cases.append(validate(c))
        require(len(cases) == 17, 'Expected 17 Java cases')
        return cases

    def javascript(self):
        root = self.root / 'faster-function-selection-20261021'
        summary = self.read(root / 'summary.json')
        require(not summary['errors'], 'JavaScript evidence audit failed')
        cases = []
        for row in summary['primaryCases']:
            run = root / 'runs' / row['project'] / row['case']
            features = self.read(run / 'features/features.json')
            files = features['files']
            result = self.read(root / 'results' / row['project'] / (row['case'] + '.json'))
            ids = [f['id'] for f in files]
            c = self.case('javascript', row['project'], row['case'], files,
                          [ids.index(v) for v in result['originalRevealingFiles']], 'native-serial', 'seeded-ast-mutation',
                          'd3e3811df4f23dc73de56a32728c044a3b7de6d5')
            execution = self.read(run / 'selected/execution.json')
            original = self.root / 'faster-external-validation-20261009/runs' / row['project'] / row['case']
            oracle = vitest_records(self.read(original / 'apfd/execution.json'))
            attempt = next(i + 1 for i, trial in enumerate(result['control']['attempts']) if trial['passes'])
            control_case = 'control-' + result['mutation']['revision'][:12] + '-' + str(attempt)
            control = vitest_records(self.read(root / 'runs' / row['project'] / control_case / 'warm/execution.json'))
            audit = verify_subset(oracle, vitest_records(execution), features['selected'], control)
            c['policies'] = {'FASTER': [[ids.index(v) for v in execution['order']]]}
            c['provenance'] = {'result': (root / 'results' / row['project'] / (row['case'] + '.json')).relative_to(self.root).as_posix(),
                               'nativeAudit': audit, 'timingAudit': audit_timing(features['frozenUTC'], execution)}
            require(case_metrics(c)['FASTER']['meanFirstFailureRankWhenDetected'] == row['functionRank'], 'Recorded JavaScript rank changed')
            cases.append(validate(c))
        require(len(cases) == 18, 'Expected 18 JavaScript cases')
        return cases

    def attempts(self):
        rows = []
        keys = ('project', 'fixed', 'buggyParent', 'case', 'date', 'message', 'issue', 'status', 'reason')
        for name in ['faster-java-external-validation-20261010', 'faster-java-external-validation-20261020', 'faster-java-dbutils-validation-20261020']:
            rows.extend({'cohort': 'java', **{k: r[k] for k in keys if k in r}} for r in self.read(self.root / name / 'ledger.json'))
        for path in sorted((self.root / 'faster-external-validation-20261009/results').glob('*/*.json')):
            row = self.read(path)
            if row.get('kind') == 'production-mutation':
                rows.append({'cohort': 'javascript', **{k: row[k] for k in keys if k in row}})
        for row in rows:
            if 'reason' in row:
                row['reason'] = row['reason'].replace(str(self.root) + '/', '')
        require(len(rows) == 103, 'Attempt ledger changed')
        return rows


def import_evidence(root, destination):
    importer = Importer(root)
    cases = importer.java() + importer.javascript()
    payload = ''.join(json.dumps(c, separators=(',', ':'), allow_nan=False) + '\n' for c in cases).encode()
    destination.mkdir(parents=True, exist_ok=True)
    blob = gzip.compress(payload, mtime=0)
    (destination / 'cases.jsonl.gz').write_bytes(blob)
    attempts = (json.dumps(importer.attempts(), indent=2) + '\n').encode()
    (destination / 'attempts.json').write_bytes(attempts)
    manifest = {'schemaVersion': 1, 'caseCount': len(cases),
                'casesSHA256': hashlib.sha256(blob).hexdigest(), 'attemptsSHA256': hashlib.sha256(attempts).hexdigest(),
                'cohortCounts': dict(Counter(c['cohort'] for c in cases)), 'sources': dict(sorted(importer.sources.items()))}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'cases': len(cases), 'bytes': len(blob), 'sources': len(importer.sources)}, indent=2))
