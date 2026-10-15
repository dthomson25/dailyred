// How good a team's matchup against RED is, before any battle: for each of
// RED's six Pokémon, the team's best one-on-one win chance at full HP (attacking
// or one setup move first, simulated with RED's AI). Then checks how well that
// predicts the knockouts the agent actually got on each team.
//
//   node team-strength.mjs                          # teams from these batches
//   node team-strength.mjs --tags board,newteams --policies jev,openai
import { readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { bestPlan, redTeamFromSource } from './brain.mjs';

const field = { weather: {}, playerSide: {}, foeSide: {} };
const RED = redTeamFromSource();
const out = (f) => new URL(`./output/${f}`, import.meta.url);

// The team (full HP) from the first snapshot of any battle on that seed.
function partyOf(log) {
  const L = readFileSync(log.replace('//', '/'), 'utf8').trim().split('\n').map(JSON.parse);
  const raw = L.find((l) => l.raw)?.raw;
  return raw ? [raw.you, ...raw.bench, ...(raw.fainted ?? [])].map((m) => ({ ...m, hp: m.maxHp, status1: 0, stages: [6, 6, 6, 6, 6, 6, 6, 6] })) : null;
}

export function teamStrength(party) {
  const perRed = RED.map((r) => {
    const ranked = party.map((m) => ({ m, ...bestPlan(m, r, field) })).sort((a, b) => b.p - a.p);
    return { red: r.speciesName, best: ranked[0].m.speciesName, p: ranked[0].p, answers: ranked.filter((x) => x.p >= 0.5).length };
  });
  return {
    meanBest: perRed.reduce((a, x) => a + x.p, 0) / perRed.length,
    covered: perRed.filter((x) => x.p >= 0.5).length,
    perRed,
  };
}

// Run directly: the report.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
const { values: args } = parseArgs({ options: {
  tags: { type: 'string', default: 'board,newteams,newteams-sim,night-teams' },
  policies: { type: 'string', default: 'jev,openai' },
} });
  // Results per seed and group (tag + policy).
  const teams = new Map(); // seed -> { party, results: { 'board jev': [ko...] } }
  for (const tag of args.tags.split(',')) {
    if (!existsSync(out(`${tag}-summary.json`))) continue;
    for (const r of JSON.parse(readFileSync(out(`${tag}-summary.json`), 'utf8'))) {
      if (r.redKnockedOut == null || !r.decisionLog) continue;
      const t = teams.get(r.seed) ?? { results: {} };
      t.party ??= partyOf(r.decisionLog);
      const group = `${tag} ${r.policy}`;
      (t.results[group] ??= []).push(r.redKnockedOut);
      teams.set(r.seed, t);
    }
  }

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const corr = (xs, ys) => {
    const mx = mean(xs), my = mean(ys);
    const sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0);
    return sxy / Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  };
  const rows = [];
  for (const [seed, t] of teams) {
    if (!t.party) continue;
    const s = teamStrength(t.party);
    const models = Object.entries(t.results).filter(([g]) => args.policies.split(',').some((p) => g.endsWith(` ${p}`))).flatMap(([, v]) => v);
    const sim = Object.entries(t.results).filter(([g]) => g.endsWith(' sim')).flatMap(([, v]) => v);
    rows.push({ seed, ...s, models: models.length ? mean(models) : null, n: models.length, sim: sim.length ? mean(sim) : null, team: t.party.map((m) => m.speciesName).join(', ') });
  }
  rows.sort((a, b) => b.meanBest - a.meanBest);
  console.log('seed        strength  RED covered  models (n)   sim    team');
  for (const r of rows) {
    console.log(`${r.seed.padEnd(11)} ${(100 * r.meanBest).toFixed(0).padStart(5)}%   ${String(r.covered).padStart(5)}/6   ${r.models == null ? '   -   ' : `${r.models.toFixed(2)} (${r.n})`.padEnd(10)} ${r.sim == null ? '  -  ' : r.sim.toFixed(2)}   ${r.team}`);
  }
  const withModels = rows.filter((r) => r.models != null);
  console.log(`\ncorrelation of strength with the models' knockouts: ${corr(withModels.map((r) => r.meanBest), withModels.map((r) => r.models)).toFixed(2)} over ${withModels.length} teams`);
  console.log(`correlation of RED Pokémon covered with the models' knockouts: ${corr(withModels.map((r) => r.covered), withModels.map((r) => r.models)).toFixed(2)}`);
  const withSim = rows.filter((r) => r.sim != null);
  if (withSim.length > 2) console.log(`correlation of strength with the sim player's knockouts: ${corr(withSim.map((r) => r.meanBest), withSim.map((r) => r.sim)).toFixed(2)} over ${withSim.length} teams`);
}
