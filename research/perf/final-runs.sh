#!/bin/sh
# Final equivalence and benchmark runs, one at a time. Usage: sh research/perf/final-runs.sh
set -e
REPO=$(cd "$(dirname "$0")/../.." && pwd)
MAIN=${FASTER_MAIN_REPO:-/Users/tiagol./Documents/pesquisa/faster}
W=$MAIN/research/work
OLD=${FASTER_OLD_BUILD:-$MAIN/.claude/worktrees/faster-perf-baseline-997c738}
export COREPACK_HOME=$W/toolchain/corepack FASTER_MAIN_REPO=$MAIN
cd "$REPO"
replay() { node --import tsx research/perf/replay.ts --builds "old=$OLD,new=$REPO" "$@"; }
load() { (pgrep -fl "study.ts|mutants.ts|instability-probe" | cut -c1-150; uptime) > "$W/$1.load.txt" || true; }
pick() { python3 -c "import json;e=json.load(open('$W/$1/manifest.json'))['entries'];print(','.join(e[i]['revision'] for i in (10,20,30,40)))"; }
replay --study "$W/unocss-pr5407-study-03" --out "$W/perf-eq-unocss-01" --forks "$W/perf-forks-eq" --project unit --isolate > "$W/perf-eq-unocss-01.log" 2>&1
for s in valibot pathe; do
  load perf-bench-$s-02
  replay --study "$W/$s-window50-study-01" --out "$W/perf-bench-$s-02" --forks "$W/perf-forks-bench" --revisions "$(pick $s-window50-study-01)" --checks '' --bench 6 --stock > "$W/perf-bench-$s-02.log" 2>&1
done
load perf-bench-unocss-03
replay --study "$W/unocss-pr5407-study-03" --out "$W/perf-bench-unocss-03" --forks "$W/perf-forks-bench" --project unit --isolate --revisions b6476b5289 --checks '' --bench 12 --stock > "$W/perf-bench-unocss-03.log" 2>&1
