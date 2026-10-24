#!/usr/bin/env python3
"""Portable entry point. Python 3.10+, standard library only."""
import argparse
import gzip
import hashlib
import json
from pathlib import Path

from benchmark.metrics import case_metrics, compare, require, summarize, validate

ROOT = Path(__file__).resolve().parent


def load_cases(path):
    opener = gzip.open if path.suffix == '.gz' else open
    with opener(path, 'rt', encoding='utf8') as stream:
        return [validate(json.loads(line)) for line in stream if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['validate', 'summarize', 'compare', 'inspect', 'import-evidence'])
    parser.add_argument('--data', type=Path, default=ROOT / 'data/cases.jsonl.gz')
    parser.add_argument('--cohort')
    parser.add_argument('--project')
    parser.add_argument('--case')
    parser.add_argument('--partition', choices=['development', 'outside-jsoup'])
    parser.add_argument('--aggregate', choices=['project', 'cohort'], default='project')
    parser.add_argument('--left')
    parser.add_argument('--right')
    parser.add_argument('--metric', choices=['APFDf', 'skippedFraction', 'revealingUnitRecall'], default='APFDf')
    parser.add_argument('--evidence-root', type=Path, help='Directory containing the original outputs/ folders')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.action == 'import-evidence':
        require(args.evidence_root is not None and args.out is not None, 'Supply --evidence-root and --out')
        from benchmark.import_evidence import import_evidence
        import_evidence(args.evidence_root.resolve(), args.out.resolve())
        return
    cases = load_cases(args.data)
    keys = [(c['cohort'], c['project'], c['case']) for c in cases]
    require(len(keys) == len(set(keys)), 'Duplicate case identity')
    if args.action == 'validate':
        manifest_path = args.data.parent / 'manifest.json'
        require(manifest_path.exists(), 'Missing evidence manifest')
        manifest = json.loads(manifest_path.read_text())
        require(hashlib.sha256(args.data.read_bytes()).hexdigest() == manifest['casesSHA256'], 'Dataset hash mismatch')
        require(len(cases) == manifest['caseCount'], 'Dataset case count mismatch')
        require(hashlib.sha256((args.data.parent / 'attempts.json').read_bytes()).hexdigest()
                == manifest['attemptsSHA256'], 'Attempt ledger hash mismatch')
        result = {'valid': True, 'cases': len(cases), 'cohorts': manifest['cohortCounts']}
        if args.evidence_root:
            evidence = args.evidence_root.resolve()
            for relative, expected in manifest['sources'].items():
                source = (evidence / relative).resolve()
                require(source.is_relative_to(evidence), 'Evidence source outside configured root')
                require(hashlib.sha256(source.read_bytes()).hexdigest() == expected, f'Source hash mismatch: {relative}')
            result['sourceHashesVerified'] = len(manifest['sources'])
    else:
        cases = [c for c in cases if (not args.cohort or c['cohort'] == args.cohort)
                 and (not args.project or c['project'] == args.project)
                 and (not args.case or c['case'] == args.case)
                 and (not args.partition or c.get('partition') == args.partition)]
        require(bool(cases), 'No cases match the filter')
        if args.action == 'summarize':
            result = summarize(cases, args.aggregate)
        elif args.action == 'inspect':
            require(bool(args.case), 'Inspect requires --case to avoid dumping an entire dataset')
            result = [{**{k: v for k, v in c.items() if k != 'policies'}, 'metrics': case_metrics(c)} for c in cases]
        else:
            require(bool(args.left and args.right), 'Supply --left and --right')
            result = compare(cases, args.left, args.right, args.metric)
    text = json.dumps(result, indent=2, allow_nan=False) + '\n'
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text)
    else:
        print(text, end='')


if __name__ == '__main__':
    main()
