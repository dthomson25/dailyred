# Daily Red agent

Plays the day's Daily Red battle against RED by itself, using
[Jev](https://docs.typesafe.ai/) (TypeSafe's System One model) to choose the
lead, every move and every switch.

```sh
cd agent && npm install
echo TYPESAFE_API_KEY=... > .env   # git-ignored; or export it (OPENAI_API_KEY, BRAINTRUST_API_KEY too)
node play.mjs                      # today's team, in a Chrome window you can watch
node play.mjs --headless           # no window (e.g. for batch runs)
node play.mjs --seed 1234          # any other team
node play.mjs --policy openai      # OpenAI's Decisions API instead of Jev (OPENAI_API_KEY)
node play.mjs --policy greedy      # no model: always the strongest attack (baseline)
node play.mjs --lead Dugtrio       # force the lead (for measuring leads)
node decision-tests.mjs            # option-text checks, no model, no game
node decision-tests.mjs --policy both
```

## What needs the Daily Red ROM hack

The agent lives in `agent/` of this Daily Red fork and depends on the ROM hack
in two different ways:

- **Decisions** (`brain.mjs`, `redai.mjs`, `damage.mjs`, `data.mjs`): option
  text, the port of RED's FireRed AI (move choice and switch-in), the
  one-on-one simulations, the Jev and OpenAI calls, decision tests, replays
  and evals. These only need static game data: move, species and type tables
  and RED's party. That comes from `data/game-data.json`, a snapshot of the
  decomp's source, so they run with no checkout. Regenerate it after changing
  the hack: `node scripts/export-game-data.mjs`.
- **Live play** (`play.mjs`, `battle.mjs`, `experiment.mjs`, `lead-sweep.mjs`):
  drives the game in the website's emulator, reads battle RAM through the built
  ROM's symbol map, uses Daily Red's test helpers (`tests/lib.mjs`,
  `tests/party.mjs`) and daily seed (`web/daily.js`), and walks to RED on the
  hack's map. This needs the ROM built (the main README's quick start, then
  `cd tests && npm install`). Set `DAILYRED_DIR` to use another checkout. The game runs in practice mode, so
  nothing counts as your daily battle.

Options: `--orders N` (ask each choice in N option orders and average; default
2, as listed and reversed. With 4 the extra two are rotations. 4 orders changed
the final pick in only 3% of Jev's and 7% of OpenAI's decisions, for about 70%
more tokens), `--roles sticky|replan`, `--model NAME` (Jev version, or the Decisions model for `--policy openai`;
default `gpt-6-luna`), `--speed 4` (fast-forward; default 4x, `--speed 1` for normal
speed), `--sound` (game sound, sped up to match `--speed`; muted by default),
`--show-jev` (print each Jev request and response in brief: one line per
question with the top answers, plus token counts), `--show-jev-full` (print them in full),
`--date 2026-10-13` (that day's team), `--model jev-1.13` (pin a Jev
version), `--screenshots` (one per decision), `--no-lead` (keep the party
order).

## How it works

```
emulator RAM ──readBattle──▶ battle state ──code──▶ legal actions, each described in words
     ▲                                                   │  damage ranges, KO odds, speed order,
     │                                                   │  type matchups, moves that would fail
     └──── button presses (useMove / switchTo) ◀── Jev Choice: which action wins the battle?
```

- **`battle.mjs`** reads the battle out of game RAM (`gBattleMons`, both
  parties, `gDisableStructs`, weather, screens) and knows what the game is
  waiting for by checking which player-controller function is running
  (`HandleInputChooseAction`, `HandleInputChooseMove`, the party menu). It
  presses the buttons to pick a move or a switch, and notices when the game
  refuses one (Disable, Taunt, Choice Band lock, trapping).
- **`damage.mjs`** is the Gen 3 damage formula: stats and stages, STAB, the
  type chart, items (Choice Band, Light Ball, type boosters), burn, screens,
  weather and the abilities that change damage most. Jev isn't a calculator,
  so every number is worked out here.
- **`brain.mjs`** turns each legal action into a sentence: "Use Surf (Water,
  95 power…). Expected damage to Charizard: 88-104% of its current HP, super
  effective x2; may knock it out (about 70% chance). You move before
  Charizard." Switches describe the hit the incoming Pokémon takes and what it
  can do afterwards. Jev gets the battle state plus these options as one
  **Choice** ("which action gives the best chance of winning the whole
  battle?"). The same Choice is asked twice in the same request with the
  options in opposite orders and the probabilities averaged, because the order
  of options can sway the model. A **Score** in the same request rates how the
  battle is going (printed as the outlook).
- **Switching has a cost:** RED gets a free attack on the incoming Pokémon.
  Code only offers a switch when the incoming Pokémon can take that hit (the
  attack RED is most likely to use does at most 40% of its HP, and none of
  RED's attacks knock it out), and never straight back to a Pokémon switched
  out in the last two turns. Jev is told to switch only to save the current
  Pokémon for later, to take a hit it is immune to (Ground into Flying), or to
  burn RED's PP; the state shows RED's PP left.
- **`--policy openai`** asks the same questions through OpenAI's
  [Decisions API](https://developers.openai.com/api/docs/guides/decisions)
  (`POST /v1/decisions`, model `gpt-6-luna`), the same kind of model as Jev:
  typed choice and score questions answered with a probability for every
  option. It gets the same state, option descriptions and two-order averaging;
  its instructions must be plain text, so the guidance is joined into one
  string. That makes the two directly comparable on the same seed.
- **"No good option":** every choice also offers "none of these actions is a
  good option". Without it the Decisions API answers hopeless positions with a
  `refusal` (seen on 4 of 44 decisions). The agent still plays the best real
  option, renormalized without it, and prints how strongly the model said
  nothing was good. A refusal is retried once, then the greedy pick is used.
- **Reserved vs filler:** before the battle, one request asks, for each of
  RED's Pokémon, which of yours is the best answer to it (or none). After
  that, roles are sticky (`--roles sticky`, the default): an assignment is
  asked about again only when it breaks (its Pokémon faints, or stops winning
  the one-on-one it won when picked). That cut input tokens by about 40%
  against re-planning everything after every faint (`--roles replan`), with
  no loss in results. Code supplies the one-on-one numbers: damage
  both ways, who's faster, who wins. A Pokémon picked for a RED Pokémon that
  isn't out yet is *reserved* for it; the rest are *filler*. Roles appear in
  the state and on every send-in and switch option, and filler may be switched
  in as knockout bait to save a reserved Pokémon in danger (its faint then
  gives a free send-in). Filler in battle may also be left to faint: its move
  options say so and name who comes in for free next, and a switch that only
  saves filler is marked as costing the incoming Pokémon a hit for little gain.
  Roles print as `Roles (asked about Snorlax): Snorlax → Machamp (88%), …`.
- **Toxic and contact moves:** the Toxic option carries a code-run simulation
  of "Toxic first, then your best attack" against "best attack alone" (turns to
  knock out from the foe's current HP, counting Leftovers), plus how many of the
  foe's attacks you survive and whether it can heal or Rest. Contact moves
  (`FLAG_MAKES_CONTACT`) against Static, Flame Body, Poison Point or Effect Spore
  say the chance to be paralyzed, burned or poisoned (1 in 3, or 1 in 10 for
  Effect Spore, as in `battle_util.c`), on lead options too.
- **Perish Song:** both counts are read from RAM (`STATUS3_PERISH_SONG` and
  the timer in `gDisableStructs`). Once it's in effect the guidance switches to
  stalling: Protect and tank switches are described in terms of the countdown,
  switching out is marked as clearing your own count, and on your last turn any
  switch that survives the incoming hit is offered. RED's AI switches out on
  its own last turn unless trapped (`ShouldSwitchIfPerishSong`), and the model
  is told so.
- **Timing:** each decision prints the API's latency; each run ends with the
  average, median and slowest request.
- **Lead:** before the battle, Jev picks the lead from each Pokémon's matchup
  against RED's Pikachu and how many of RED's Pokémon it hits hard (RED's team
  is read from `src/dailyred_boss.c`). The agent then moves it to the front
  through the party menu's SWITCH, as a player would.
- **`data.mjs`** parses moves, species, abilities and the type chart from the
  decomp's source, so it matches the ROM.

The agent knows RED's moves (they're fixed and listed in the main README) but
not his choices ahead of time.

## Offline evaluation

`replay.mjs` replays logged decisions through a model and scores the picks,
without the emulator: about 500 decisions in 10–15 seconds, against 25 minutes
for a 24-battle batch, and with no battle luck in the numbers.

```sh
node replay.mjs --policy jev --from exp4x-v7               # an experiment's decisions
node replay.mjs --policy openai --from exp4x-v7 --logs-of jev   # only Jev's positions
node replay.mjs --policy logged --from exp4x-v7            # score the picks already logged
node replay.mjs --policy jev --layout plain --orders 4 output/*.jsonl
node replay.mjs --policy jev --from exp4x-v8 --braintrust  # also log it to Braintrust
```

With `--braintrust` (and `BRAINTRUST_API_KEY` in `.env`) each replay becomes an
experiment in the `daily-red-agent` project: one row per decision with the
state, options, pick, probabilities and scores, so runs can be compared row by
row in Braintrust's UI. Only the git commit, branch and dirty flag are sent,
never diffs. Rows carry short fields to group and filter by: `position`,
`pick_label`, `pick_kind` (attack, status, protect, switch, send-in), `team`,
`pick_flagged`, `safe_ko_available`, `differs_from_logged`.

Battle results go to Braintrust too: `node braintrust-battles.mjs` logs every
batch (one experiment per batch and model, named like `battles v7 · jev`, one
row per battle, scored by `red_knocked_out` and `won`, described by what that
version changed), and `experiment.mjs --braintrust` does it for new batches.

Scorers count only where they apply: `takes_safe_ko` (took a sure knockout
when one existed), `avoids_flagged` (avoided options marked Wasted, Will fail,
Unreliable or Faints before attacking when an unmarked one existed),
`no_overkill` and `no_pointless_switch`. Decisions logged with a raw battle
snapshot (newer logs) are rebuilt with the current option code, so changes to
option text and rules can be tested offline; older ones reuse their logged text.
`experiment.mjs` runs live battle matrices and `crosscheck.mjs` asks the other
model about every logged decision.

## Decision tests (no emulator)

`decision-tests.mjs` checks hand-built situations with a known right answer.
The decision layer only needs a battle object, so `scenario.mjs` builds one in
a few lines (`mon('Pinsir', { moves: [...] })`, `red('Charizard', { hp: '3%' })`,
`makeBattle({...})`) and no game runs.

```sh
node decision-tests.mjs --prompts-only            # option-text checks, no model calls
node decision-tests.mjs --policy both --repeat 2  # also ask Jev and OpenAI
node decision-tests.mjs --only Toxic --show       # one case, printing every option
```

Each case in `decision-tests/cases.mjs` has two kinds of check:

- **Prompt checks** (free, instant): the option text must say the right thing,
  e.g. Hyper Beam's option mentions the recharge cost and "Overkill", or a move
  that will fail is not offered.
- **Decision checks**: the model must pick one of the expected options (or avoid
  some). `filter: false` shows flagged options with their warnings instead of
  removing them, to test whether the model heeds the warning.

Write the expected answer from the game's actual facts, and run with `--show`
first: several first drafts turned out ambiguous (RED's AI switches out at
Perish Song count 0; a "sure" knockout that wasn't sure with the test's stats).
The script exits non-zero on any failure.

## Output

Every decision prints the top options with Jev's probabilities:

```
Turn 3: Gyarados 81% healthy vs RED's Charizard 100% healthy
  →  71%  Use Surf (Water, 95 power, 100% accuracy, 15 PP left)
      18%  Use Earthquake (Ground, 100 power, 100% accuracy, 10 PP left)
      ...
    outlook 2.31 / 4 (0 losing … 4 winning)
```

and `output/<seed>-<policy>-<time>.jsonl` logs every decision with the
exact Jev request (`decision.request`) and response (`decision.response`), for
comparing runs. `--show-jev` prints a one-line summary of each as it happens,
`--show-jev-full` the full JSON.

## Known limitations

- Damage estimates skip critical hits, and a few moves (Low Kick, Magnitude,
  Present) use an average power.
- Natures for RED's lead are assumed neutral when choosing the lead (the
  in-battle numbers use his real stats from RAM).
- The emulator fast-forwards at 4x by default. Emscripten normally runs one
  frame per display refresh (60 fps), so `bootGame` drives its main loop from a
  `MessageChannel` instead, and `ensureSpeed` resends RetroArch's
  `FAST_FORWARD` once the game is running (it is lost if sent during boot).
  Each run prints the measured speed, e.g. `Emulator: 239 frames/s (4.0x)`.
