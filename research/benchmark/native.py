"""Shared native membership and outcome checks for both language adapters."""
from collections import Counter

from .metrics import require


def vitest_records(execution):
    require(not execution.get('errors'), 'Unhandled Vitest errors invalidate a run')
    order = execution['order']
    modules = execution['modules']
    require(len(set(order)) == len(order), 'Duplicate native module start')
    require(set(order) == {m['file'] for m in modules}, 'Missing native module completion')
    require(len(modules) == len(order), 'Duplicate native module completion')
    records = {name: {'id': name, 'tests': []} for name in order}
    states = {'passed': 'pass', 'failed': 'fail', 'skipped': 'skip', 'pending': 'skip', 'todo': 'skip'}
    for test in execution['cases']:
        require(test['file'] in records, 'Unknown test module')
        require(test['state'] in states, f"Unknown Vitest test state: {test['state']}")
        records[test['file']]['tests'].append({'id': test['file'] + '::' + test['name'], 'state': states[test['state']]})
    for module in modules:
        tests = records[module['file']]['tests']
        require(not module.get('errors'), 'Collection-level module error')
        require(module['state'] != 'failed' or any(t['state'] == 'fail' for t in tests), 'Unattributed module failure')
    return records


def membership(records):
    return Counter((unit, test['id']) for unit, record in records.items() for test in record['tests'])


def outcomes(records):
    return Counter((unit, test['id'], test['state']) for unit, record in records.items() for test in record['tests'])


def verify_subset(oracle, subset, selected, control):
    require(len(set(selected)) == len(selected), 'Duplicate requested unit')
    require(bool(oracle) and set(selected) <= set(oracle), 'Selection outside full oracle')
    require(membership(control) == membership(oracle), 'Passing control membership differs from oracle')
    require(all(t['state'] != 'fail' for r in control.values() for t in r['tests']), 'Unmodified full control fails')
    require(set(subset) == set(selected), 'Native selected class/file membership differs from request')
    expected = {unit: record for unit, record in oracle.items() if unit in selected}
    require(membership(subset) == membership(expected), 'Selected test method membership differs from full oracle')
    require(outcomes(subset) == outcomes(expected), 'Selected pass/fail/skip vector differs from full oracle')
    full_failures = {(u, t['id']) for u, r in oracle.items() for t in r['tests'] if t['state'] == 'fail'}
    require(bool(full_failures), 'No stable target fault in oracle')
    passing = {(u, t['id']) for u, r in control.items() for t in r['tests'] if t['state'] == 'pass'}
    require(full_failures <= passing, 'Target failure identities do not pass in unmodified control')
    subset_failures = {(u, t['id']) for u, r in subset.items() for t in r['tests'] if t['state'] == 'fail'}
    return {'membershipMatches': True, 'outcomesMatch': True,
            'faultDetected': bool(subset_failures),
            'revealingMethodsRetained': len(full_failures & subset_failures),
            'revealingMethodsTotal': len(full_failures)}
