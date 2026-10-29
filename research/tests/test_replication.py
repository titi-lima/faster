import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from replicate import load_plan, mutate


class ReplicationTests(unittest.TestCase):
    def test_plan_covers_the_exact_recorded_cohorts(self):
        plan, cases = load_plan()
        self.assertEqual(len(cases), 35)
        self.assertEqual(len(plan['subjects']), 7)
        for spec in plan['cases']:
            case = cases[spec['project'], spec['case']]
            self.assertEqual(spec['cohort'], case['cohort'])
            self.assertRegex(spec['revision'], r'^[a-f0-9]{40}$')
            self.assertTrue(spec['failingMethods'])
            if spec['cohort'] == 'java':
                self.assertRegex(spec['parent'], r'^[a-f0-9]{40}$')
                self.assertEqual(set(spec['dependencies']), set(case['tests']))
                self.assertEqual(set(spec['priors']), {f['id'] for f in case['features'] if f['known']})
            else:
                self.assertEqual(set(spec['durations']), set(case['tests']))

    def test_mutation_requires_exact_source_and_replacement(self):
        digest = lambda text: hashlib.sha256(text.encode()).hexdigest()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / 'source.ts'
            path.write_text('return a === b')
            mutation = {'path': 'source.ts', 'offset': 9, 'before': '===', 'after': '!==',
                        'sourceSHA256': digest('return a === b'), 'mutatedSHA256': digest('return a !== b')}
            mutate(root, mutation)
            self.assertEqual(path.read_text(), 'return a !== b')
            with self.assertRaisesRegex(ValueError, 'source differs'):
                mutate(root, mutation)
            path.write_text('return a === b')
            with self.assertRaisesRegex(ValueError, 'result differs'):
                mutate(root, {**mutation, 'after': '>'})
            with self.assertRaisesRegex(ValueError, 'escapes checkout'):
                mutate(root, {**mutation, 'path': '../source.ts'})


if __name__ == '__main__':
    unittest.main()
