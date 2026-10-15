// Which computed facts change the model's decisions? Replays logged positions
// (rebuilt with the current code) through a model once with every fact, then
// once per ablation with one kind of fact removed, and counts how often the
// pick changes. Offline: no emulator, no battles.
//
//   node ablate.mjs --policy jev --from board --limit 150
//
// Ablations: the threat board (state), "Plan:" lines (setup vs attacking),
// sleep turns left (state and options), "Exchange:" lines (one-on-ones on
// switches and send-ins).
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import {
  JevBrain, OpenAIBrain, ACTION_QUESTION, SEND_IN_QUESTION, buildTurnOptions, buildSendInOptions, turnState,
  setLayout, setStateStyle, setOrderCount, setFilterFlagged, decide,
} from './brain.mjs';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* use the environment */ }
const { values: args } = parseArgs({ options: {
  policy: { type: 'string', default: 'jev' },
  from: { type: 'string', default: 'board' },
  limit: { type: 'string', default: '150' },
  parallel: { type: 'string', default: '6' },
} });
setLayout('consequence'); setStateStyle('lean'); setOrderCount(2); setFilterFlagged(true);
const brain = args.policy === 'openai' ? new OpenAIBrain() : new JevBrain();

// Positions with a raw snapshot, spread evenly over the batch.
const rows = JSON.parse(readFileSync(new URL(`./output/${args.from}-summary.json`, import.meta.url), 'utf8'));
const all = [];
for (const r of rows) {
  if (!r.decisionLog) continue;
  for (const line of readFileSync(r.decisionLog.replace('//', '/'), 'utf8').trim().split('\n')) {
    const e = JSON.parse(line);
    if ((e.type === 'action' || e.type === 'send_in') && e.raw) all.push(e);
  }
}
const step = all.length / Math.min(Number(args.limit), all.length);
const cases = Array.from({ length: Math.min(Number(args.limit), all.length) }, (_, i) => all[Math.floor(i * step)]);

const dropSentences = (text, re) => text.split(/(?<=\.)\s+(?=[A-Z])/).filter((s) => !re.test(s)).join(' ');
const ABLATIONS = {
  // The same prompt again: how often the pick changes with nothing removed.
  control: { control: true },
  threat_board: { state: (s) => { const { red_threats, ...rest } = s; return rest; } },
  plan_lines: { option: (t) => dropSentences(t, /^Plan: /) },
  sleep_turns: { state: (s) => JSON.parse(JSON.stringify(s).replace(/asleep \([^)]*\)/g, 'asleep')), option: (t) => t.replace(/asleep \([^)]*\)/g, 'asleep') },
  exchange_lines: { option: (t) => dropSentences(t, /^Exchange( after coming in)?: /) },
};

const results = [];
let next = 0;
async function worker() {
  while (next < cases.length) {
    const e = cases[next++];
    const raw = e.raw;
    const battle = { ...raw, roles: raw.roles ? new Map(raw.roles) : undefined };
    const options = e.type === 'action' ? buildTurnOptions(battle, new Set(e.excluded ?? []), raw.history ?? []) : buildSendInOptions(battle);
    if (options.length < 2) continue;
    const state = turnState(battle);
    const question = e.type === 'action' ? ACTION_QUESTION : SEND_IN_QUESTION;
    try {
      const full = await decide(brain, state, question, options);
      const row = { turn: e.turn, type: e.type, full: full.choice, changed: {} };
      for (const [name, ab] of Object.entries(ABLATIONS)) {
        const s2 = ab.state ? ab.state(state) : state;
        const o2 = ab.option ? options.map((o) => ({ ...o, text: ab.option(o.text) })) : options;
        // Skip when the ablation removes nothing here.
        if (!ab.control && JSON.stringify(s2) === JSON.stringify(state) && o2.every((o, i) => o.text === options[i].text)) { row.changed[name] = null; continue; }
        const a = await decide(brain, s2, question, o2);
        row.changed[name] = a.choice !== full.choice;
      }
      results.push(row);
    } catch (err) { results.push({ error: err.message }); }
  }
}
await Promise.all(Array.from({ length: Number(args.parallel) }, worker));

console.log(`${args.policy}: ${results.filter((r) => !r.error).length} positions from ${args.from}`);
for (const name of Object.keys(ABLATIONS)) {
  const applies = results.filter((r) => r.changed?.[name] != null);
  const changed = applies.filter((r) => r.changed[name]).length;
  console.log(`  without ${name.padEnd(15)} present in ${String(applies.length).padStart(3)} positions; pick changed in ${changed} (${applies.length ? Math.round((100 * changed) / applies.length) : 0}%)`);
}
const errors = results.filter((r) => r.error);
if (errors.length) console.log(`  ${errors.length} errors, e.g. ${errors[0].error}`);
console.log(`  tokens: ${brain.usage.input_tokens} input, ${brain.usage.requests} requests`);
writeFileSync(new URL(`./output/ablate-${args.policy}-${args.from}.json`, import.meta.url), JSON.stringify(results, null, 1));
