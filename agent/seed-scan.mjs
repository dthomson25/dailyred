// Finds strong teams: boots the real game for many seeds, reads the team each
// one deals, and scores its matchup against RED (team-strength.mjs: the team's
// best one-on-one win chance against each of RED's six, simulated with RED's
// AI). Writes output/seed-scan.json, strongest first; play the top seeds to
// see whether a strong team actually wins.
//
//   node seed-scan.mjs --count 300            # random seeds
//   node seed-scan.mjs --from 1 --count 300   # seeds 1..300
//   node seed-scan.mjs --top 20               # print the best found so far
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadDailyRed } from './dailyred.mjs';
import { readOwnParty } from './battle.mjs';
import { teamStrength } from './team-strength.mjs';

const { values: args } = parseArgs({ options: {
  count: { type: 'string', default: '0' },
  from: { type: 'string' },
  parallel: { type: 'string', default: '3' },
  top: { type: 'string', default: '15' },
} });
const OUT = new URL('./output/seed-scan.json', import.meta.url);
const found = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const done = new Set(found.map((r) => r.seed));

const n = Number(args.count);
const seeds = args.from
  ? Array.from({ length: n }, (_, i) => Number(args.from) + i)
  : Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 0xFFFFFFFE));
const todo = seeds.filter((s) => !done.has(s));

if (todo.length) {
  const { startServer, launchBrowser, bootGame, waitFor, readMemory } = await loadDailyRed('tests/lib.mjs');
  const server = await startServer();
  const browser = await launchBrowser();
  let finished = 0;
  const one = async (seed) => {
    const page = await browser.newPage();
    try {
      await bootGame(page, server.url, { seed });
      await waitFor(page, (s) => s.inOverworld, { what: `overworld for seed ${seed}`, timeoutMs: 30000 });
      const party = readOwnParty(await readMemory(page)).filter(Boolean);
      const s = teamStrength(party);
      found.push({ seed, strength: s.meanBest, covered: s.covered, team: party.map((m) => m.speciesName), perRed: s.perRed.map((x) => `${x.red}: ${x.best} ${Math.round(100 * x.p)}%`) });
    } catch (e) {
      console.log(`seed ${seed}: ${e.message}`);
    } finally {
      await page.close();
      if (++finished % 25 === 0) { writeFileSync(OUT, JSON.stringify(found)); console.log(`${finished}/${todo.length} seeds`); }
    }
  };
  const queue = [...todo];
  await Promise.all(Array.from({ length: Number(args.parallel) }, async () => { while (queue.length) await one(queue.shift()); }));
  await browser.close();
  server.close();
  writeFileSync(OUT, JSON.stringify(found));
}

found.sort((a, b) => b.strength - a.strength);
const pct = (x) => `${Math.round(100 * x)}%`;
const strengths = found.map((r) => r.strength);
console.log(`${found.length} teams scanned. Strength: median ${pct(strengths[Math.floor(strengths.length / 2)])}, best ${pct(strengths[0])}; `
  + `${found.filter((r) => r.covered === 6).length} cover all six of RED's Pokémon.`);
for (const r of found.slice(0, Number(args.top))) {
  console.log(`\nseed ${r.seed}  strength ${pct(r.strength)}  covers ${r.covered}/6  ${r.team.join(', ')}`);
  console.log(`  ${r.perRed.join(' · ')}`);
}
process.exit(0);
