import copy
import gzip
import json
import sys
import tempfile
import unittest
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from benchmark.metrics import case_metrics, compare, score, validate
from benchmark.native import verify_subset, vitest_records
from adapters.surefire import read_reports
from adapters.java.refine import refine, scope_for


class ContractTests(unittest.TestCase):
    def test_selection_uses_full_universe_and_misses_are_zero(self):
        result = score([[4], []], [4], 10)
        self.assertEqual(result['APFDf'], .475)
        self.assertEqual(result['detectionProbability'], .5)
        self.assertEqual(result['meanFirstFailureRankWhenDetected'], 1)
        self.assertEqual(result['budgets'][0]['fullUniverseCount'], 1)
        self.assertEqual(result['budgets'][0]['detectionProbability'], .5)

    def test_multiple_revealing_units_are_one_fault(self):
        self.assertEqual(score([[2, 1, 0]], [1, 2], 3)['APFDf'], 1 - .5 / 3)
        self.assertEqual(score([[2]], [1, 2], 3)['revealingUnitRecall'], .5)

    def test_no_detection_does_not_have_a_rank(self):
        result = score([[]], [0], 3)
        self.assertEqual(result['APFDf'], 0)
        self.assertIsNone(result['meanFirstFailureRankWhenDetected'])

    def test_duplicate_and_incomplete_orders_rejected(self):
        case = {'schemaVersion': 1, 'cohort': 'fixture', 'project': 'p', 'case': 'c',
                'unit': 'test-file', 'rankEvidence': 'native-serial', 'faultModel': 'fixture',
                'tests': ['a', 'b'], 'revealing': [0], 'policies': {'p': [[0, 0]]}, 'fullPolicies': ['p']}
        with self.assertRaisesRegex(ValueError, 'duplicate test'):
            validate(case)
        case['policies']['p'] = [[0]]
        with self.assertRaisesRegex(ValueError, 'incomplete full-suite'):
            validate(case)

    def test_native_subset_is_checked_at_method_level(self):
        oracle = {'a': {'tests': [{'id': 'a::one', 'state': 'fail'}, {'id': 'a::two', 'state': 'pass'}]}}
        control = copy.deepcopy(oracle)
        control['a']['tests'][0]['state'] = 'pass'
        self.assertTrue(verify_subset(oracle, oracle, ['a'], control)['faultDetected'])
        incomplete = {'a': {'tests': oracle['a']['tests'][:1]}}
        with self.assertRaisesRegex(ValueError, 'method membership'):
            verify_subset(oracle, incomplete, ['a'], control)
        changed = copy.deepcopy(oracle)
        changed['a']['tests'][1]['state'] = 'skip'
        with self.assertRaisesRegex(ValueError, 'pass/fail/skip'):
            verify_subset(oracle, changed, ['a'], control)
        control['a']['tests'][0]['state'] = 'skip'
        with self.assertRaisesRegex(ValueError, 'do not pass'):
            verify_subset(oracle, oracle, ['a'], control)

    def test_surefire_collection_errors_are_not_passing_runs(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'TEST-A.xml'
            path.write_text('<testsuite name="A" failures="0" errors="1"/>')
            with self.assertRaisesRegex(ValueError, 'Incomplete'):
                read_reports(Path(temp))
            path.write_text('<testsuite name="A" failures="1" errors="0"><testcase classname="A" name="x"><failure type="AssertionError"/></testcase></testsuite>')
            records = read_reports(Path(temp))
            self.assertEqual(records['A']['tests'], [{'id': 'A::x', 'state': 'fail'}])

    def test_vitest_rejects_unattributed_module_failure(self):
        execution = {'order': ['a'], 'modules': [{'file': 'a', 'state': 'failed', 'errors': []}],
                     'cases': [], 'errors': []}
        with self.assertRaisesRegex(ValueError, 'Unattributed'):
            vitest_records(execution)

    def test_global_initialization_coverage_prevents_unsound_narrowing(self):
        feature = {'known': True, 'affected': True, 'changedDependencies': ['/tmp/project/target/classes/A.class']}
        prior = {'A': {'shell': 'stable', 'methods': {'f()V': 'before'}}}
        current = {'A': {'shell': 'stable', 'methods': {'f()V': 'after'}}}
        self.assertFalse(refine(feature, prior, current, {'A': set()})[0])
        coverage = scope_for({'test': {'A': []}, '__GLOBAL__': {'A': ['f()V']}}, 'test')
        self.assertTrue(refine(feature, prior, current, coverage)[0])
        self.assertTrue(refine(feature, prior, current, {})[0])
        feature['changedDependencies'] = []
        self.assertTrue(refine(feature, prior, current, {'A': set()})[0])


class RecordedEvidenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with gzip.open(ROOT / 'data/cases.jsonl.gz', 'rt') as stream:
            cls.cases = [json.loads(line) for line in stream]

    def test_all_576_cases_and_known_project_results(self):
        self.assertEqual(len(self.cases), 576)
        java = [c for c in self.cases if c['cohort'] == 'external-java-paired']
        metrics = [case_metrics(c) for c in java]
        self.assertEqual(len(metrics), 17)
        self.assertAlmostEqual(mean(m['FASTER APFD']['APFDf'] for m in metrics), .9182929500773408)
        self.assertAlmostEqual(mean(m['FASTER method selected']['skippedFraction'] for m in metrics), .23214942654456894)
        self.assertTrue(all(m['FASTER method selected']['revealingUnitRecall'] == 1 for m in metrics))
        pinia = [case_metrics(c) for c in self.cases if c['cohort'] == 'javascript-paired' and c['project'] == 'pinia']
        self.assertAlmostEqual(mean(m['FASTER function selected']['APFDf'] for m in pinia), .9479638009049773)

    def test_cross_cohort_pooling_rejected(self):
        mixed = [self.cases[0], next(c for c in self.cases if c['cohort'] == 'external-java-paired')]
        with self.assertRaisesRegex(ValueError, 'one cohort'):
            compare(mixed, 'FASTER APFD', 'Previous FASTER', draws=100)


if __name__ == '__main__':
    unittest.main()
