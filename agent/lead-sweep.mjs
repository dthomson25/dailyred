// Measures every possible lead: for each team, plays N battles per party
// member with that Pokémon forced as the lead (play.mjs --lead) and a model
// choosing everything else, then ranks the leads by RED knocked out.
// Ground truth for judging the models' lead choices.
//
//   node lead-sweep.mjs --seeds 1234,777 --rounds 3 --parallel 4
//   node lead-sweep.mjs --summary          # just print the table from finished runs
//
// Each (team, lead) is an experiment.mjs batch tagged lead-<seed>-<Species>,
// so finished battles are reused when the sweep is rerun.
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    seeds: { type: 'string', default: '1234,4159547863,777,2026' },
    rounds: { type: 'string', default: '3' },
    parallel: { type: 'string', default: '4' },
    policy: { type: 'string', default: 'jev' },
    summary: { type: 'boolean', default: false },
  },
});
const out = (f) => new URL(`./output/${f}`, import.meta.url).pathname;

// A team's party, from any earlier battle's log on that seed.
function partyOf(seed) {
  for (const tag of ['redai', 'heal', 'exchange', 'final']) {
    if (!existsSync(out(`${tag}-summary.json`))) continue;
    const row = JSON.parse(readFileSync(out(`${tag}-summary.json`), 'utf8')).find((r) => r.seed === seed && r.team);
    if (row) return row.team.split(', ');
  }
  throw new Error(`no earlier battle on seed ${seed}: run one first to learn the team`);
}

const jobs = args.seeds.split(',').flatMap((seed) => partyOf(seed).map((lead) => ({ seed, lead, tag: `lead-${seed}-${lead.replace(/\W/g, '_')}` })));

if (!args.summary) {
  let next = 0;
  const run = (job) => new Promise((resolve) => {
    const p = spawn('node', ['experiment.mjs', '--seeds', job.seed, '--policies', args.policy, '--rounds', args.rounds, '--parallel', '1', '--tag', job.tag,
      '--', '--headless', '--lead', job.lead], { cwd: new URL('.', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    p.stdout.on('data', (d) => { log += d; });
    p.stderr.on('data', (d) => { log += d; });
    p.on('close', (code) => { writeFileSync(out(`${job.tag}-console.log`), log); console.log(`${job.tag}: ${code === 0 ? 'done' : `exit ${code}`}`); resolve(); });
  });
  await Promise.all(Array.from({ length: Number(args.parallel) }, async () => { while (next < jobs.length) await run(jobs[next++]); }));
}

// --- Summary: leads ranked per team --------------------------------------------------------------
const table = [];
for (const seed of new Set(jobs.map((j) => j.seed))) {
  const rows = jobs.filter((j) => j.seed === seed).map((j) => {
    const f = out(`${j.tag}-summary.json`);
    const runs = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).filter((r) => r.redKnockedOut != null) : [];
    const ko = runs.map((r) => r.redKnockedOut);
    return { seed, lead: j.lead, battles: ko.length, mean: ko.length ? ko.reduce((a, b) => a + b, 0) / ko.length : null, wins: runs.filter((r) => r.result === 'WON').length, ko };
  }).sort((a, b) => (b.mean ?? -1) - (a.mean ?? -1));
  console.log(`\nseed ${seed}`);
  for (const r of rows) console.log(`  ${r.lead.padEnd(12)} ${r.mean == null ? '   -' : r.mean.toFixed(2)}  (${r.ko.join(', ')}${r.wins ? `; ${r.wins} won` : ''})`);
  table.push(...rows);
}
writeFileSync(out('lead-sweep.json'), JSON.stringify(table, null, 1));
