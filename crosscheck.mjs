// Asks the other model every decision a battle logged, with the exact same
// state and options, to measure how often Jev and OpenAI's Decisions API
// choose differently. (Comparing two battles directly doesn't work: they
// split apart after the first different move.)
//
//   node crosscheck.mjs output/a.jsonl output/b.jsonl ...
//
// Each log already holds one model's answer; this asks the other one.
import { readFileSync, writeFileSync } from 'node:fs';
import { JevBrain, OpenAIBrain, ACTION_QUESTION, SEND_IN_QUESTION, LEAD_QUESTION } from './brain.mjs';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* use the environment */ }

const QUESTION = { action: ACTION_QUESTION, send_in: SEND_IN_QUESTION, lead: LEAD_QUESTION };
const brains = { jev: new JevBrain(), openai: new OpenAIBrain() };

// One logged decision -> the state and options both models are given.
function caseFrom(entry, policy) {
  const req = entry.decision.request;
  const state = policy === 'jev' ? req.state : JSON.parse(req.input);
  return { type: entry.type, turn: entry.turn, state, options: entry.options, [policy]: entry.decision };
}

const cases = [];
for (const file of process.argv.slice(2)) {
  const policy = file.includes('-openai-') ? 'openai' : 'jev';
  for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
    const entry = JSON.parse(line);
    if (!QUESTION[entry.type] || !entry.decision?.request || entry.options.length < 2) continue;
    cases.push({ file, from: policy, ...caseFrom(entry, policy) });
  }
}
console.log(`${cases.length} decisions to cross-check`);

// Ask the model that didn't make each decision, a few at a time.
let next = 0;
async function worker() {
  while (next < cases.length) {
    const c = cases[next++];
    const other = c.from === 'jev' ? 'openai' : 'jev';
    try {
      c[other] = await brains[other].ask(c.state, QUESTION[c.type], c.options);
    } catch (e) {
      c[other] = { error: e.message };
    }
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

// --- Agreement ----------------------------------------------------------------------
const valid = cases.filter((c) => c.jev?.choice && c.openai?.choice);
const agree = (c) => c.jev.choice === c.openai.choice;
const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '-');
const kindOf = (key) => (key.startsWith('move_') ? 'attack/move' : 'switch');

console.log(`\nSame pick: ${valid.filter(agree).length}/${valid.length} (${pct(valid.filter(agree).length, valid.length)})`);
for (const type of ['lead', 'action', 'send_in']) {
  const group = valid.filter((c) => c.type === type);
  console.log(`  ${type.padEnd(8)} ${String(group.filter(agree).length).padStart(3)}/${String(group.length).padEnd(3)} ${pct(group.filter(agree).length, group.length)}`);
}

// Disagreements where both models were fairly sure are the interesting ones.
const top = (d) => d.probabilities[d.choice];
const sure = valid.filter((c) => top(c.jev) >= 0.5 && top(c.openai) >= 0.5);
console.log(`When both put ≥50% on their pick: ${sure.filter(agree).length}/${sure.length} same (${pct(sure.filter(agree).length, sure.length)})`);

// Switch vs attack on turn actions.
const actions = valid.filter((c) => c.type === 'action');
const switches = (who) => actions.filter((c) => kindOf(c[who].choice) === 'switch').length;
console.log(`Turn actions that are switches: Jev ${switches('jev')}/${actions.length}, OpenAI ${switches('openai')}/${actions.length}`);

console.log('\nDisagreements (both ≥50% sure first):');
const disagreements = valid.filter((c) => !agree(c))
  .sort((a, b) => Math.min(top(b.jev), top(b.openai)) - Math.min(top(a.jev), top(a.openai)));
for (const c of disagreements.slice(0, 12)) {
  const you = c.state.your_active_pokemon;
  const foe = c.state.red_active_pokemon;
  const where = you ? `${you.pokemon} ${you.hp.split(' ')[0]} vs ${foe.pokemon} ${foe.hp.split(' ')[0]}` : 'lead';
  const label = (key) => c.options.find((o) => o.key === key).text.split(' (')[0];
  console.log(`  t${c.turn} ${c.type.padEnd(7)} ${where.padEnd(34)} Jev: ${label(c.jev.choice)} (${Math.round(100 * top(c.jev))}%)  OpenAI: ${label(c.openai.choice)} (${Math.round(100 * top(c.openai))}%)`);
}

const errors = cases.filter((c) => c.jev?.error || c.openai?.error);
if (errors.length) console.log(`\n${errors.length} requests failed: ${[...new Set(errors.map((c) => c.jev?.error ?? c.openai?.error))].join('; ')}`);
writeFileSync(new URL('./output/crosscheck.json', import.meta.url), JSON.stringify(cases, null, 1));
console.log('\nAll cases: output/crosscheck.json');
