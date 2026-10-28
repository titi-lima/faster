"""One scoring definition for Java classes and JavaScript files.

Each case represents ONE fault, potentially revealed by several test units.
Misses score zero and have no first-failure rank. Budgets always use full N.
"""
import math
import random
from statistics import mean

BUDGETS = (.1, .2, .25, .3, .4, .5, .6, .7, .75, .8, .9, 1.)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(case):
    require(case.get('schemaVersion') == 1, 'Unsupported case schema')
    for key in ('cohort', 'project', 'case', 'unit', 'rankEvidence', 'faultModel'):
        require(isinstance(case.get(key), str) and bool(case[key]), f'Missing {key}')
    require(case['unit'] in ('java-class', 'test-file'), 'Invalid test unit')
    require(case['rankEvidence'] in ('offline-replay', 'native-serial'), 'Invalid rank evidence')
    ids = case['tests']
    require(bool(ids) and all(isinstance(i, str) and i for i in ids), 'Empty test universe')
    require(len(set(ids)) == len(ids), 'Duplicate test identity')
    faults = case['revealing']
    require(bool(faults) and len(set(faults)) == len(faults), 'Missing or duplicate revealing unit')
    require(all(type(i) is int and 0 <= i < len(ids) for i in faults), 'Revealing unit outside universe')
    require(bool(case['policies']), 'No policies')
    require(set(case.get('fullPolicies', [])) <= set(case['policies']), 'Unknown full-suite policy')
    for name, trials in case['policies'].items():
        require(bool(trials), f'{name}: no trials')
        for order in trials:
            require(isinstance(order, list), f'{name}: order must be a list')
            require(all(type(i) is int and 0 <= i < len(ids) for i in order), f'{name}: invalid index')
            require(len(set(order)) == len(order), f'{name}: duplicate test in order')
        if name in case.get('fullPolicies', []):
            require(all(len(o) == len(ids) for o in trials), f'{name}: incomplete full-suite order')
    return case


def score(orders, revealing, full_n):
    ranks = [next((j + 1 for j, i in enumerate(o) if i in revealing), None) for o in orders]
    observed = [r for r in ranks if r is not None]
    return {
        'APFDf': mean(0. if r is None else 1 - (r - .5) / full_n for r in ranks),
        'meanFirstFailureRankWhenDetected': mean(observed) if observed else None,
        'detectionProbability': len(observed) / len(ranks),
        'revealingUnitRecall': mean(len(set(o) & set(revealing)) / len(revealing) for o in orders),
        'skippedFraction': mean(1 - len(o) / full_n for o in orders),
        'meanRetainedUnits': mean(len(o) for o in orders),
        'budgets': [{
            'fraction': b,
            'fullUniverseCount': math.floor(full_n * b),
            'detectionProbability': mean(r is not None and r <= math.floor(full_n * b) for r in ranks),
            'allTrialsHit': all(r is not None and r <= math.floor(full_n * b) for r in ranks),
        } for b in BUDGETS],
    }


def case_metrics(case):
    validate(case)
    return {name: score(orders, case['revealing'], len(case['tests']))
            for name, orders in case['policies'].items()}


def summarize(cases, aggregate='project'):
    groups = {}
    for case in cases:
        for policy, values in case_metrics(case).items():
            key = (case['cohort'], case['project'] if aggregate == 'project' else 'ALL', policy)
            groups.setdefault(key, []).append(values)
    rows = []
    for (cohort, project, policy), values in sorted(groups.items()):
        row = {'cohort': cohort, 'project': project, 'policy': policy, 'cases': len(values), 'weighting': 'case-mean'}
        for metric in ('APFDf', 'detectionProbability', 'revealingUnitRecall', 'skippedFraction', 'meanRetainedUnits'):
            row[metric] = mean(v[metric] for v in values)
        ranks = [v['meanFirstFailureRankWhenDetected'] for v in values
                 if v['meanFirstFailureRankWhenDetected'] is not None]
        row['meanFirstFailureRankWhenDetected'] = mean(ranks) if ranks else None
        rows.append(row)
    return rows


def compare(cases, left, right, metric='APFDf', draws=20000, seed=20261024):
    require(draws >= 100, 'Use at least 100 bootstrap draws')
    groups = {}
    cohorts = set()
    for case in cases:
        metrics = case_metrics(case)
        require(left in metrics and right in metrics, f"Unpaired case: {case['case']}")
        a, b = metrics[left][metric], metrics[right][metric]
        require(a is not None and b is not None, 'Conditional ranks cannot be compared when a case misses')
        groups.setdefault(case['project'], []).append(a - b)
        cohorts.add(case['cohort'])
    require(len(cohorts) == 1, 'Compare one cohort at a time; do not pool different fault models')
    projects = sorted(groups)
    rng = random.Random(seed)
    samples = []
    for _ in range(draws):
        samples.append(mean(mean(rng.choices(groups[p], k=len(groups[p])))
                            for p in rng.choices(projects, k=len(projects))))
    samples.sort()
    return {
        'left': left, 'right': right, 'metric': metric, 'projects': len(projects),
        'cases': sum(map(len, groups.values())), 'seed': seed, 'draws': draws,
        'projectBalancedDifference': mean(mean(v) for v in groups.values()),
        'percentile95Interval': [samples[math.floor(.025 * draws)], samples[math.floor(.975 * draws)]],
        'pairedPositive': sum(d > 1e-12 for v in groups.values() for d in v),
        'pairedTies': sum(abs(d) <= 1e-12 for v in groups.values() for d in v),
        'pairedNegative': sum(d < -1e-12 for v in groups.values() for d in v),
        'qualification': 'Hierarchical project-then-case bootstrap; convenience sample, not a recall/soundness guarantee. Positive means left has a larger value.',
    }
