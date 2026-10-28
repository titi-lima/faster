"""Determine affected tests from changed methods and recorded coverage.

CLI: refine.py FEATURES CURRENT_MODEL PRIOR_INDEX OUTPUT
PRIOR_INDEX maps test IDs to {model: JSON path, coverage: JSON path}; paths are
relative to the index. Coverage includes per-class scopes and __GLOBAL__.
"""
import json
import sys
from pathlib import Path


def refine(feature, prior_model, current_model, coverage):
    if not feature['known'] or not feature['affected']:
        return feature['affected'], []
    reasons = []
    if not feature.get('changedDependencies'):
        return True, [{'decision': 'fallback', 'reason': 'Missing changed-dependency attribution'}]
    for path in feature['changedDependencies']:
        if '/target/classes/' not in path:
            reasons.append({'path': path, 'decision': 'fallback', 'reason': 'Resource, external dependency, or test bytecode'})
            continue
        cls = path.split('/target/classes/')[1].removesuffix('.class')
        old, now = prior_model.get(cls), current_model.get(cls)
        if old is None or now is None or old.get('shell') != now.get('shell') or set(old['methods']) != set(now['methods']):
            reasons.append({'class': cls, 'decision': 'fallback', 'reason': 'Class structure or method set changed / missing model'})
            continue
        changed = {m for m, h in old['methods'].items() if now['methods'][m] != h}
        if not changed:
            reasons.append({'class': cls, 'decision': 'fallback', 'reason': 'Byte change has no attributed method change'})
            continue
        if '<clinit>()V' in changed or cls not in coverage:
            reasons.append({'class': cls, 'decision': 'fallback', 'reason': 'Static initialization changed or no class coverage'})
            continue
        hit = sorted(changed & set(coverage[cls]))
        reasons.append({'class': cls, 'decision': 'affected' if hit else 'unaffected',
                        'changedMethods': sorted(changed), 'coveredChangedMethods': hit})
    return any(r['decision'] != 'unaffected' for r in reasons), reasons


def scope_for(coverage, test_id):
    scope = {cls: set(methods) for cls, methods in coverage.get(test_id, {}).items()}
    for cls, methods in coverage.get('__GLOBAL__', {}).items():
        scope.setdefault(cls, set()).update(methods)
    return scope


def main():
    source, current_path, index_path, output = map(Path, sys.argv[1:])
    read = lambda p: json.loads(p.read_text())
    features, current, index = read(source), read(current_path), read(index_path)
    files, decisions = [], []
    for feature in features['files']:
        if feature['known'] and feature['id'] in index:
            prior = index[feature['id']]
            model = read(index_path.parent / prior['model'])
            coverage = read(index_path.parent / prior['coverage'])
            affected, reasons = refine(feature, model, current, scope_for(coverage, feature['id']))
        else:
            affected, reasons = feature['affected'], [{'decision': 'fallback', 'reason': 'No usable prior index'}]
        files.append({**feature, 'affected': affected})
        decisions.append({'id': feature['id'], 'dependencyChanged': feature['affected'], 'affected': affected, 'reasons': reasons})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({**features, 'files': files}, indent=2) + '\n')
    output.with_suffix('.decisions.json').write_text(json.dumps(decisions, indent=2) + '\n')


if __name__ == '__main__':
    main()
