// Offline evaluation: replays logged battle decisions through a model and
// scores the picks, without running the emulator. Minutes instead of a
// 25-minute batch, and no battle luck in the numbers.
//
//   node replay.mjs --policy jev --layout consequence output/*.jsonl
//   node replay.mjs --policy openai --orders 4 --limit 300 output/*-v7*.jsonl
//   node replay.mjs --policy logged output/*.jsonl      # score the picks already in the logs
//   node replay.mjs --policy openai --from exp4x-v7 --logs-of jev   # an experiment's logs
//   node replay.mjs --policy jev --from exp4x-v8 --braintrust         # also log to Braintrust
//   node replay.mjs --policy jev --from exp4x-v8 --mode score         # rate each option separately
//   node replay.mjs --policy jev --from exp4x-v8 --instructions flat  # Jev with plain-text instructions
//   node replay.mjs --policy jev --from exp4x-v8 --mode hybrid        # Score filters mistakes, Choice picks
//   node replay.mjs --policy jev --from exp4x-v8 --state lean         # smaller state
//
// With --braintrust each run is an experiment in the "daily-red-agent" project
// (BRAINTRUST_API_KEY in .env): one row per decision with the state, options,
// pick, probabilities and scores. Only the git commit, branch and dirty flag
// are sent, never diffs.
//
// Decisions logged with a raw battle snapshot are rebuilt with the current
// option code (so new option text and rules are tested); older ones reuse
// their logged state and option text (so only model, order or question
// changes are tested). Writes output/replay-<tag>.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { init as initBraintrust } from 'braintrust';
import {
  JevBrain, OpenAIBrain, ACTION_QUESTION, SEND_IN_QUESTION, buildTurnOptions, buildSendInOptions, turnState,
  setOrderCount, setLayout, setInstructionStyle, setDecisionMode, setStateStyle, leanState, decide,
} from './brain.mjs';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* use the environment */ }

const { values: args, positionals: files } = parseArgs({
  allowPositionals: true,
  options: {
    policy: { type: 'string', default: 'jev' },
    layout: { type: 'string', default: 'consequence' },
    orders: { type: 'string', default: '2' },
    limit: { type: 'string', default: '400' },
    parallel: { type: 'string', default: '6' },
    tag: { type: 'string' },
    from: { type: 'string' },     // an experiment tag: use its decision logs
    'logs-of': { type: 'string' }, // only that policy's logs from --from
    braintrust: { type: 'boolean', default: false }, // log the run as a Braintrust experiment
    mode: { type: 'string', default: 'choice' },               // choice | score | hybrid (Score filters, Choice picks)
    state: { type: 'string', default: 'full' },                // full | lean (drop roles, history, other Pokémon)
    instructions: { type: 'string', default: 'structured' },   // structured | flat (Jev only)
  },
});
if (args.from) {
  const rows = JSON.parse(readFileSync(new URL(`./output/${args.from}-summary.json`, import.meta.url), 'utf8'));
  files.push(...rows.filter((r) => !args['logs-of'] || r.policy === args['logs-of']).map((r) => r.decisionLog).filter(Boolean));
}
setLayout(args.layout);
setInstructionStyle(args.instructions);
setDecisionMode(args.mode);
setStateStyle(args.state);
setOrderCount(Number(args.orders));
const brain = args.policy === 'jev' ? new JevBrain() : args.policy === 'openai' ? new OpenAIBrain() : null;

// --- Dataset: action and send-in decisions from the logs, spread evenly ------------------------
const all = [];
for (const file of files) {
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const entry = JSON.parse(line);
    if ((entry.type === 'action' || entry.type === 'send_in') && entry.options?.length >= 2 && entry.decision?.choice) all.push({ file, entry });
  }
}
const limit = Math.min(Number(args.limit), all.length);
const step = all.length / limit;
const cases = Array.from({ length: limit }, (_, i) => all[Math.floor(i * step)]);

// Rebuild a decision's state and options with the current code when possible.
function prepare({ entry }) {
  const raw = entry.raw;
  if (raw && args.policy !== 'logged') {
    const battle = { ...raw, roles: raw.roles ? new Map(raw.roles) : undefined };
    const options = entry.type === 'action'
      ? buildTurnOptions(battle, new Set(entry.excluded ?? []), raw.history ?? [])
      : buildSendInOptions(battle);
    return { state: turnState(battle), options, rebuilt: true };
  }
  const req = entry.decision.request;
  const logged = req?.state ?? (req?.input ? JSON.parse(req.input) : null);
  return { state: args.state === 'lean' && logged ? leanState(logged) : logged, options: entry.options, rebuilt: false };
}

// --- Scorers: each applies only where it can be judged ----------------------------------------
const FLAG = /^(Danger|Warning|Wasted|Will fail|Unreliable|Faints before attacking):|Danger: |Warning: |Wasted: |Will fail: |Faints before attacking: /;
const flagged = (o) => FLAG.test(o.text);
// A move (not a switch, whose text also describes the incoming Pokémon's attacks)
// that knocks the foe out this turn for sure: 100% accuracy and no warning.
const sureKo = (o) => o.key.startsWith('move_') && !flagged(o)
  && (o.sureKo ?? (/guaranteed to knock it out/.test(o.text) && /100% accuracy|never misses/.test(o.text)));
const SCORERS = {
  // A safe guaranteed knockout was available: did it take one?
  takes_safe_ko: (opts, pick) => (opts.some(sureKo) ? +sureKo(pick) : null),
  // Some option had no warning: did it avoid the flagged ones?
  avoids_flagged: (opts, pick) => (opts.some(flagged) && opts.some((o) => !flagged(o)) ? +!flagged(pick) : null),
  // A cleaner move also guaranteed the knockout: did it avoid the costly one?
  no_overkill: (opts, pick) => (opts.some((o) => /Overkill:/.test(o.text)) ? +!/Overkill:/.test(pick.text) : null),
  // A switch with no benefit was offered: did it avoid it?
  no_pointless_switch: (opts, pick) => (opts.some((o) => /No benefit:|Little benefit:/.test(o.text)) ? +!/No benefit:|Little benefit:/.test(pick.text) : null),
};

// Short, groupable fields for Braintrust's tables and filters.
function describe(c, state, options, pick) {
  const you = state?.your_active_pokemon, foe = state?.red_active_pokemon;
  const label = pick.text.split(' (')[0].replace(/^(Use|Switch out to|Send in) /, '').replace(/^(Wasted|Will fail|Unreliable|Knocks|May knock|Faints before attacking|No benefit|Benefit|Little benefit|Sacrifice)[^.]*\.\s*/, '');
  const kind = pick.key.startsWith('switch_') ? 'switch' : pick.key.startsWith('send_') ? 'send-in'
    : /Use (Protect|Detect|Endure)/.test(pick.text) ? 'protect' : /status move/.test(pick.text) ? 'status' : 'attack';
  return {
    position: you && foe ? `${you.pokemon} ${you.hp.split(' ')[0]} vs ${foe.pokemon} ${foe.hp.split(' ')[0]} (turn ${state.turn})` : `turn ${c.entry.turn}`,
    pick_label: pick.text.match(/(?:Use|Switch out to|Send in) ([^(.]+?) \(/)?.[1] ?? label,
    pick_kind: kind,
    decision_type: c.entry.type,
    team: c.file.split('/').pop().split('-')[0].replace('4109215006', 'today'),
    batch: args.from ?? null,
    layout: args.layout, orders: Number(args.orders),
    pick_flagged: flagged(pick),
    safe_ko_available: options.some(sureKo),
    differs_from_logged: c.entry.decision.choice !== pick.key,
    logged_choice: c.entry.decision.choice,
    log: c.file.split('/').pop(), turn: c.entry.turn,
  };
}

// --- Run ---------------------------------------------------------------------------------------
const tag = args.tag ?? `${args.policy}-${args.layout}-${args.orders}orders-${args.mode}-${args.instructions}-${args.state}`;
const experiment = args.braintrust ? initBraintrust({
  project: 'daily-red-agent',
  experiment: args.tag ?? `replay ${args.from ? `${(args.from.match(/v\d+$/)?.[0] ?? (args.from === 'exp4x' ? 'v1' : args.from))} ` : ''}· ${args.policy}${args.layout !== 'consequence' ? ` · ${args.layout}` : ''}${args.orders !== '2' ? ` · ${args.orders} orders` : ''}${args.mode !== 'choice' ? ` · ${args.mode} per option` : ''}${args.instructions !== 'structured' ? ` · ${args.instructions} instructions` : ''}${args.state !== 'full' ? ` · ${args.state} state` : ''}`,
  tags: ['replay', args.policy],
  metadata: { kind: 'replay', policy: args.policy, layout: args.layout, orders: Number(args.orders), from: args.from ?? null, logs_of: args['logs-of'] ?? null, decisions: cases.length },
  gitMetadataSettings: { collect: 'some', fields: ['commit', 'branch', 'dirty'] },
}) : null;

const results = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    const { state, options, rebuilt } = prepare(c);
    if (!options.length) continue;
    let answer;
    const startedAt = Date.now() / 1000;
    try {
      const question = c.entry.type === 'action' ? ACTION_QUESTION : SEND_IN_QUESTION;
      answer = !brain ? c.entry.decision : await decide(brain, state, question, options);
    } catch (e) {
      results.push({ file: c.file, turn: c.entry.turn, error: e.message });
      continue;
    }
    const choice = answer.choice;
    const pick = options.find((o) => o.key === choice) ?? options[0];
    const scores = Object.fromEntries(Object.entries(SCORERS).map(([name, f]) => [name, f(options, pick)]));
    results.push({ file: c.file, type: c.entry.type, turn: c.entry.turn, rebuilt, choice, pick: pick.text.slice(0, 160), scores });
    experiment?.log({
      input: { state, options: options.map((o) => ({ key: o.key, text: o.text })) },
      output: { choice, pick: pick.text, probabilities: answer.probabilities, no_good_option: answer.noGoodOption },
      // Braintrust scores are 0-1; scorers that don't apply to this decision are left out.
      scores: Object.fromEntries(Object.entries(scores).filter(([, v]) => v != null)),
      metadata: { ...describe(c, state, options, pick), rebuilt, latency_ms: answer.latencyMs, orders_agreeing: answer.ordersAgreeing },
      // Fills Braintrust's Duration and token columns (a logged pick has no timing of its own).
      metrics: {
        ...(brain ? { start: startedAt, end: Date.now() / 1000 } : {}),
        prompt_tokens: answer.response?.usage?.input_tokens ?? 0,
        completion_tokens: answer.response?.usage?.output_tokens ?? 0,
        tokens: (answer.response?.usage?.input_tokens ?? 0) + (answer.response?.usage?.output_tokens ?? 0),
      },
    });
  }
}
const started = Date.now();
await Promise.all(Array.from({ length: Number(args.parallel) }, worker));

console.log(`${tag}: ${results.length} decisions (${results.filter((r) => r.rebuilt).length} rebuilt with current code) in ${Math.round((Date.now() - started) / 1000)} s`);
for (const name of Object.keys(SCORERS)) {
  const scored = results.filter((r) => r.scores?.[name] != null);
  const ok = scored.filter((r) => r.scores[name] === 1).length;
  console.log(`  ${name.padEnd(20)} ${scored.length ? `${Math.round((100 * ok) / scored.length)}%` : '-'}  (${ok}/${scored.length})`);
}
if (brain) console.log(`  tokens: ${brain.usage.input_tokens} input, ${brain.usage.requests} requests`);
const errors = results.filter((r) => r.error);
if (errors.length) console.log(`  ${errors.length} errors, e.g. ${errors[0].error}`);
writeFileSync(new URL(`./output/replay-${tag}.json`, import.meta.url), JSON.stringify(results, null, 1));
if (experiment) {
  const summary = await experiment.summarize();
  console.log(`  Braintrust: ${summary.experimentUrl ?? '(no URL returned)'}`);
}
