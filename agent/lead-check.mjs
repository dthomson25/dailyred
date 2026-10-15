// Asks a model for its lead on each team with the current lead options (no
// emulator): the party comes from an earlier battle's first snapshot.
//
//   node lead-check.mjs --policy jev
//   node lead-check.mjs --policy openai --seeds 1234,777
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { JevBrain, OpenAIBrain, buildLeadOptions, redTeamFromSource, setLayout, setOrderCount } from './brain.mjs';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* use the environment */ }
const { values: args } = parseArgs({ options: {
  policy: { type: 'string', default: 'jev' },
  seeds: { type: 'string', default: '1234,4159547863,777,2026' },
  from: { type: 'string', default: 'ppboost' },
  show: { type: 'boolean', default: false },
  roles: { type: 'boolean', default: true }, // use the role plan that battle used (as play.mjs does)
} });
setLayout('consequence');
setOrderCount(2);
const brain = args.policy === 'openai' ? new OpenAIBrain() : new JevBrain();
const rows = JSON.parse(readFileSync(new URL(`./output/${args.from}-summary.json`, import.meta.url), 'utf8'));
const redTeam = redTeamFromSource();
for (const seed of args.seeds.split(',')) {
  const row = rows.find((r) => r.seed === seed && r.decisionLog);
  const L = readFileSync(row.decisionLog, 'utf8').trim().split('\n').map(JSON.parse);
  const raw = L.find((l) => l.type === 'action' && l.raw)?.raw;
  const party = [raw.you, ...raw.bench, ...(raw.fainted ?? [])].map((m) => ({ ...m, hp: m.maxHp, status1: 0 }));
  // The battle's role plan: answer to the Pokémon out first (Pikachu), reserved for the rest.
  let roles = null;
  const plan = L.find((l) => l.type === 'roles')?.plan;
  if (args.roles && plan) {
    roles = new Map();
    for (const [red, p] of Object.entries(plan)) {
      if (!p.answer) continue;
      const role = roles.get(p.answer) ?? { reservedFor: [], answerTo: [] };
      (red === redTeam[0].speciesName ? role.answerTo : role.reservedFor).push(red);
      roles.set(p.answer, role);
    }
  }
  const options = buildLeadOptions(party, redTeam, roles);
  const d = await brain.chooseLead(party, redTeam, options);
  const ranked = Object.entries(d.probabilities).sort((a, b) => b[1] - a[1]).map(([k, p]) => `${k.replace('lead_', '')} ${Math.round(p * 100)}%`);
  console.log(`${seed}: ${ranked.join(', ')}`);
  if (args.show) for (const o of options) console.log(`  ${o.key}: ${o.text}`);
}
