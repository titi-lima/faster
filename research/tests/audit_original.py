"""Optional audit against separately held raw Java evidence, not a new native run.

Requires workspace dependencies and Node on PATH, plus the original outputs.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from adapters.java.refine import refine, scope_for
from benchmark.metrics import require


def read(path):
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence-root', type=Path, required=True)
    args = parser.parse_args()
    method = args.evidence_root / 'faster-java-method-selection-20261021'
    plan = read(method / 'plan.json')
    checked = 0
    out = ROOT / 'work/adapter-audit'
    out.mkdir(parents=True, exist_ok=True)
    for case in plan['cases']:
        pid, phase, rev = case['project'], case['phase'], case['fixed']
        name = 'faster-java-external-validation-20261010' if phase == 'Phase1' else 'faster-java-external-validation-20261020'
        old = args.evidence_root / name / 'results' / pid / rev[:8]
        current = read(method / 'coverage' / phase / pid / rev[:8] / 'model.json')
        features = read(old / 'features.json')['files']
        expected = read(method / 'results' / phase / pid / rev[:8] / 'features.json')['files']
        for feature, recorded in zip(features, expected):
            affected = feature['affected']
            if feature['known']:
                prior = method / 'coverage' / phase / pid / case['priors'][feature['id']]['revision'][:8]
                affected, _ = refine(feature, read(prior / 'model.json'), current,
                                     scope_for(read(prior / 'coverage.json'), feature['id']))
            require(affected == recorded['affected'], f"Method affectedness drift: {pid}/{rev}/{feature['id']}")
            checked += 1
        require(len(features) == len(expected), 'Method universe changed')
        for label, directory in [('file', old), ('method', method / 'results' / phase / pid / rev[:8])]:
            output = out / f'{phase}-{pid}-{rev[:8]}-{label}.json'
            subprocess.run(['node', '--import', 'tsx', str(ROOT / 'adapters/order.ts'),
                            str(directory / 'features.json'), str(output)], cwd=ROOT.parent, check=True)
            actual, frozen = read(output), read(directory / 'frozen-orders.json')
            for key in ['order', 'oldOrder', 'baseline', 'fastOrder']:
                require(actual[key] == frozen[key], f'{label} ordering drift: {pid}/{rev}/{key}')
    print(json.dumps({'cases': len(plan['cases']), 'featureObservations': checked,
                      'orderingReplays': len(plan['cases']) * 2, 'allMatch': True}, indent=2))


if __name__ == '__main__':
    main()
