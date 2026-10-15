#!/bin/bash
# Overnight queue (2026-10-14). Run with: caffeinate -i ./overnight2.sh
# No Braintrust logging (keeps its monthly quota); everything stays in output/.
# Progress: output/overnight2.log. Each step keeps going if an earlier one fails,
# and rerunning skips battles that already finished.
cd "$(dirname "$0")"
LOG=output/overnight2.log
step() { echo "[$(date '+%H:%M:%S')] $*" | tee -a $LOG; }
run() { step "START $1"; shift; "$@" > "output/$TAG-console.log" 2>&1 && step "DONE" || step "FAILED (exit $?)"; }

PINNED=1234,4159547863,777,2026
NEW=31,62,93,124,155,186,217,248,279,310,341,372

# 1. Do the gains hold on teams never used before? Both models, 2 rounds.
TAG=newteams run "new teams" node experiment.mjs --seeds $NEW --policies jev,openai --rounds 2 --parallel 3 --tag newteams -- --headless
# 2. Tighter numbers on the current setup: extends the threat-board batch from 6 to 14 rounds.
TAG=board run "board: more rounds" node experiment.mjs --seeds $PINNED --policies jev,openai --rounds 14 --parallel 3 --tag board -- --headless
# 3. Confidence routing: Jev, with OpenAI only on Jev's close calls.
TAG=route run "routing" node experiment.mjs --seeds $PINNED --policies route --rounds 6 --parallel 3 --tag route -- --headless
# 4. No model at all: options scored by the simulations alone.
TAG=sim run "sim player" node experiment.mjs --seeds $PINNED --policies sim --rounds 6 --parallel 3 --tag sim -- --headless
# 5. Offline: which computed facts change Jev's picks (threat board, plan lines, sleep turns, exchange lines).
TAG=ablate run "ablation" node ablate.mjs --policy jev --from board --limit 150
step "ALL DONE"
