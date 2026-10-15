#!/bin/bash
# Overnight experiment queue. Run with:  caffeinate -i ./overnight.sh
# Each step keeps going if an earlier one fails. Progress: output/overnight.log
# Summary for the morning: output/overnight-summary.md
cd "$(dirname "$0")"
LOG=output/overnight.log
SUM=output/overnight-summary.md
step() { echo "[$(date '+%H:%M:%S')] $*" | tee -a $LOG; }
run() { step "START $1"; shift; "$@" >> $LOG 2>&1 && step "DONE" || step "FAILED (exit $?)"; }

echo "# Overnight experiments ($(date '+%Y-%m-%d'))" > $SUM

# 0. Let the noise and baseline batches finish first (same machine, same emulators).
step "waiting for running batches"
while pgrep -f "experiment.mjs" > /dev/null; do sleep 30; done
for t in noise baselines; do echo -e "\n## $t\n\`\`\`" >> $SUM; sed -n '/^seed/,/^$/p;/^[a-z]*: [0-9]*\/[0-9]* wins/p' output/$t-console.log >> $SUM; echo '```' >> $SUM; done

# 1. Offline replays on v8's positions (logged to Braintrust).
for args in "--policy jev --mode hybrid" "--policy openai --mode hybrid" "--policy jev --state lean" "--policy openai --state lean"; do
  run "replay $args" bash -c "node replay.mjs $args --limit 600 --from exp4x-v8 --braintrust | tee -a $SUM.tmp"
done
echo -e "\n## Offline replays (v8 positions)\n\`\`\`" >> $SUM; grep -v "Braintrust:" $SUM.tmp >> $SUM; echo '```' >> $SUM; rm -f $SUM.tmp

# 2. Live batches: 4 teams x 2 models x 6 rounds, headless, traced to Braintrust Logs.
SEEDS=1234,today,777,2026
run "night-control" node experiment.mjs --seeds $SEEDS --policies jev,openai --rounds 6 --parallel 4 --tag night-control --braintrust -- --headless --trace
run "night-filter" node experiment.mjs --seeds $SEEDS --policies jev,openai --rounds 6 --parallel 4 --tag night-filter --braintrust -- --headless --trace --filter-flagged
run "night-hybrid" node experiment.mjs --seeds $SEEDS --policies jev,openai --rounds 6 --parallel 4 --tag night-hybrid --braintrust -- --headless --trace --mode hybrid
run "night-teams" node experiment.mjs --seeds 101,202,303,404,505,606,707,808,909,1010 --policies jev,openai --rounds 1 --parallel 4 --tag night-teams --braintrust -- --headless --trace
for t in night-control night-filter night-hybrid night-teams; do echo -e "\n## $t\n\`\`\`" >> $SUM; sed -n '/^seed/,/^$/p;/^[a-z]*: [0-9]*\/[0-9]* wins/p' output/$t-console.log >> $SUM; echo '```' >> $SUM; done

# 3. Offline A/B on tonight's positions, rebuilt with the current code (local only, to save Braintrust scores).
for args in "--policy jev --layout plain" "--policy jev --layout consequence" "--policy openai --layout plain" "--policy openai --layout consequence" "--policy jev --orders 4"; do
  run "rebuilt replay $args" bash -c "node replay.mjs $args --limit 600 --from night-control | tee -a $SUM.tmp"
done
echo -e "\n## Rebuilt replays (night-control positions, current code)\n\`\`\`" >> $SUM; cat $SUM.tmp >> $SUM; echo '```' >> $SUM; rm -f $SUM.tmp
step "ALL DONE"
