"""Build the pinned research Java tools from an existing Maven dependency cache.

Usage: build.py --m2 /path/to/m2 --java-home /path/to/jdk8 [--out DIR]
"""
import argparse
import hashlib
import json
import os
import subprocess
import zipfile
from pathlib import Path


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--m2', type=Path, required=True)
    parser.add_argument('--java-home', type=Path, required=True)
    parser.add_argument('--out', type=Path, default=root.parents[1] / 'work/java-tools')
    args = parser.parse_args()
    out = args.out.resolve()
    classes = out / 'classes'
    classes.mkdir(parents=True, exist_ok=True)
    dependencies = json.loads((root / 'dependencies.json').read_text())
    jars = []
    for relative, expected in dependencies.items():
        path = (args.m2 / relative).resolve()
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            raise ValueError(f'Java dependency hash mismatch: {relative}')
        jars.append(path)
    classpath = os.pathsep.join(map(str, [classes, *jars]))
    subprocess.run([str(args.java_home / 'bin/javac'), '-source', '8', '-target', '8',
                    '-cp', classpath, '-d', str(classes), *map(str, sorted(root.glob('*.java')))], check=True)
    asm_jars = [p for p in jars if '/org/ow2/asm/' in p.as_posix()]
    with zipfile.ZipFile(out / 'scope-agent.jar', 'w') as jar:
        jar.writestr('META-INF/MANIFEST.MF', 'Manifest-Version: 1.0\nPremain-Class: ScopeAgent\n\n')
        for path in sorted(classes.glob('ScopeAgent*.class')):
            jar.write(path, path.name)
        for path in asm_jars:
            with zipfile.ZipFile(path) as source:
                for name in source.namelist():
                    if name.endswith('.class') and name != 'module-info.class':
                        jar.writestr(name, source.read(name))
    (out / 'classpath.txt').write_text(classpath + '\n')
    print(out / 'scope-agent.jar')


if __name__ == '__main__':
    main()
