#!/usr/bin/env python3
"""Native result normalization and common control/subset checks."""
import argparse
import json
from pathlib import Path

from adapters.surefire import read_reports
from benchmark.native import verify_subset, vitest_records


def read(path):
    return json.loads(path.read_text())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='action', required=True)
    for action in ['vitest', 'surefire']:
        p = sub.add_parser(action)
        p.add_argument('input', type=Path)
        p.add_argument('output', type=Path)
    p = sub.add_parser('audit-subset')
    for name in ['oracle', 'subset', 'selected', 'control']:
        p.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'audit-subset':
        print(json.dumps(verify_subset(read(args.oracle), read(args.subset), read(args.selected), read(args.control)), indent=2))
    else:
        records = vitest_records(read(args.input)) if args.action == 'vitest' else read_reports(args.input)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(records, indent=2) + '\n')


if __name__ == '__main__':
    main()
