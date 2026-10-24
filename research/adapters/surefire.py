"""Normalize fresh Maven Surefire XML without claiming an execution order.

Usage: python3 research/adapters/surefire.py REPORT_DIRECTORY RECORDS.json
"""
import json
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def read_reports(directory):
    reports = sorted(directory.glob('TEST-*.xml'))
    if not reports:
        raise ValueError('No native Surefire reports')
    records = {}
    for path in reports:
        root = ET.parse(path).getroot()
        suites = [root] if root.tag == 'testsuite' else list(root.iter('testsuite'))
        for suite in suites:
            name = suite.get('name')
            if not name or name in records:
                raise ValueError(f'Missing or duplicate suite identity: {name}')
            tests, failures = [], []
            for test in suite.findall('testcase'):
                identity = f"{test.get('classname', name)}::{test.attrib['name']}"
                state = 'skip' if test.find('skipped') is not None else 'pass'
                for failure in list(test.findall('failure')) + list(test.findall('error')):
                    state = 'fail'
                    failures.append({'test': identity, 'exception': failure.get('type', ''),
                                     'message': failure.get('message', ''), 'trace': failure.text or ''})
                tests.append({'id': identity, 'state': state})
            # Collection-level errors without test cases must not become a pass.
            declared = int(suite.get('failures', '0')) + int(suite.get('errors', '0'))
            if declared != len(failures) or not tests:
                raise ValueError(f'Incomplete or inconsistent Surefire suite: {name}')
            records[name] = {'id': name, 'runCount': sum(t['state'] != 'skip' for t in tests),
                             'durationMs': float(suite.get('time', '0')) * 1000,
                             'failed': bool(failures), 'failures': failures, 'tests': tests}
    return records


if __name__ == '__main__':
    Path(sys.argv[2]).write_text(json.dumps(read_reports(Path(sys.argv[1])), indent=2) + '\n')
