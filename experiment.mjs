// Runs a matrix of battles (seeds x policies x rounds), a few at a time, and
// prints a summary from their decision logs.
//
//   node experiment.mjs --seeds 1234,today,777 --policies jev,openai --rounds 2 --parallel 4 --tag exp1
//
// Each battle's console output goes to output/<tag>-<policy>-<seed>-r<round>.log
// and the summary to output/<tag>-summary.json. Extra flags after "--" are
// passed to play.mjs (e.g. -- --headless). --braintrust logs the batch as
// Braintrust experiments (see braintrust-battles.mjs; add the batch's
// description to BATCH_NOTES there). Rerunning the same command skips
// battles whose log already has a result, so an interrupted experiment resumes.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    seeds: { type: 'string', default: '1234,today' },
    policies: { type: 'string', default: 'jev,openai' },
    rounds: { type: 'string', default: '2' },
    parallel: { type: 'string', default: '4' },
    tag: { type: 'string', default: `exp-${Date.now()}` },
    braintrust: { type: 'boolean', default: false }, // log the batch to Braintrust when done
  },
});

const OUT = new URL('./output/', import.meta.url).pathname;
const runs = [];
for (let round = 1; round <= Number(args.rounds); round++) {
  for (const seed of args.seeds.split(',')) {
    for (const policy of args.policies.split(',')) runs.push({ round, seed, policy });
  }
}
console.log(`${runs.length} battles, ${args.parallel} at a time (tag ${args.tag})`);

function play(run) {
  const logPath = `${OUT}${args.tag}-${run.policy}-${run.seed}-r${run.round}.log`;
  if (existsSync(logPath)) {
    const text = readFileSync(logPath, 'utf8');
    const decisionLog = text.match(/Decision log: (\S+)/)?.[1]?.replace(/\/\//g, '/');
    if (/^Result: (WON|LOST)/m.test(text) && decisionLog && existsSync(decisionLog)) {
      Object.assign(run, { decisionLog, speed: text.match(/^Emulator: (\d+) frames/m)?.[1], reused: true });
      console.log(`  reused: ${run.policy} seed ${run.seed} round ${run.round} — ${text.match(/^Result: (.*)$/m)[1]}`);
      return Promise.resolve();
    }
  }
  return new Promise((resolve) => {
    const flags = ['play.mjs', '--policy', run.policy, ...(run.seed === 'today' ? [] : ['--seed', run.seed]), ...positionals];
    const log = createWriteStream(logPath);
    const child = spawn(process.execPath, flags, { cwd: new URL('.', import.meta.url).pathname });
    let text = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (d) => { text += d; log.write(d); });
    const drained = new Promise((ok) => child.stdout.on('end', ok));
    child.on('exit', async (code) => {
      await Promise.race([drained, new Promise((ok) => setTimeout(ok, 2000))]);
      log.end();
      run.decisionLog = text.match(/Decision log: (\S+)/)?.[1]?.replace(/\/\//g, '/');
      run.speed = text.match(/^Emulator: (\d+) frames/m)?.[1];
      run.exit = code;
      console.log(`  done: ${run.policy} seed ${run.seed} round ${run.round} — ${text.match(/^Result: (.*)$/m)?.[1] ?? `exit ${code}`}`);
      resolve();
    });
  });
}

let next = 0;
await Promise.all(Array.from({ length: Number(args.parallel) }, async () => {
  while (next < runs.length) await play(runs[next++]);
}));

// --- Summary from the decision logs -------------------------------------------------
const stateOf = (d) => d?.request?.state ?? (d?.request?.input ? JSON.parse(d.request.input) : null);
const rows = [];
for (const run of runs) {
  if (!run.decisionLog) { rows.push({ ...run, error: 'no decision log' }); continue; }
  const L = readFileSync(run.decisionLog, 'utf8').trim().split('\n').map(JSON.parse);
  const result = L.find((l) => l.type === 'result');
  const acts = L.filter((l) => l.type === 'action' || l.type === 'send_in');
  const last = [...acts].reverse().map((l) => stateOf(l.decision)).find((s) => s?.red_other_pokemon);
  // No-model policies make no requests; their raw snapshots still have RED's party.
  const lastRaw = [...acts].reverse().find((l) => l.raw?.foeTeam)?.raw;
  const won = result?.outcome === 'WON';
  const latencies = L.flatMap((l) => [l.decision?.latencyMs, l.type === 'roles' ? l.latencyMs : undefined]).filter((x) => x !== undefined).sort((a, b) => a - b);
  rows.push({
    ...run,
    team: L.find((l) => l.type === 'team')?.party.join(', '),
    result: result?.outcome ?? 'unfinished',
    redKnockedOut: won ? 6 : last ? last.red_other_pokemon.filter((x) => x.includes('fainted')).length
      : lastRaw ? lastRaw.foeTeam.filter((m) => m.hp === 0).length : null,
    redLeft: won ? null : last ? `${last.red_active_pokemon.pokemon} ${last.red_active_pokemon.hp.split(' ')[0]}`
      : lastRaw ? `${lastRaw.foe.speciesName} ${Math.round((100 * lastRaw.foe.hp) / lastRaw.foe.maxHp)}%` : null,
    turns: acts.length ? Math.max(...acts.map((a) => a.turn)) : 0,
    requests: result?.usage?.requests,
    inputTokens: result?.usage?.input_tokens,
    outputTokens: result?.usage?.output_tokens,
    medianMs: latencies[Math.floor(latencies.length / 2)],
    mismatches: L.filter((l) => l.type === 'move_mismatch').length,
  });
}
writeFileSync(`${OUT}${args.tag}-summary.json`, JSON.stringify(rows, null, 1));

console.log('\nseed      policy  wins  avg RED KO  per battle');
for (const seed of args.seeds.split(',')) {
  for (const policy of args.policies.split(',')) {
    const g = rows.filter((r) => r.seed === seed && r.policy === policy && r.redKnockedOut != null);
    const ko = g.map((r) => r.redKnockedOut);
    console.log(`${seed.padEnd(9)} ${policy.padEnd(7)} ${String(g.filter((r) => r.result === 'WON').length).padStart(4)}  ${(ko.reduce((a, b) => a + b, 0) / (ko.length || 1)).toFixed(2).padStart(10)}  ${ko.join(', ')}`);
  }
}
for (const policy of args.policies.split(',')) {
  const g = rows.filter((r) => r.policy === policy && r.redKnockedOut != null);
  const avg = (k) => Math.round(g.reduce((a, r) => a + (r[k] ?? 0), 0) / (g.length || 1));
  console.log(`${policy}: ${g.filter((r) => r.result === 'WON').length}/${g.length} wins, ${(g.reduce((a, r) => a + r.redKnockedOut, 0) / (g.length || 1)).toFixed(2)} RED knocked out on average, ${avg('inputTokens')} input tokens and ${avg('medianMs')} ms median per battle`);
}
const problems = rows.filter((r) => r.error || r.result === 'unfinished' || r.mismatches);
if (problems.length) console.log(`\nCheck these runs: ${problems.map((r) => `${r.policy}/${r.seed}/r${r.round} (${r.error ?? (r.mismatches ? `${r.mismatches} move mismatches` : r.result)})`).join('; ')}`);
if (args.braintrust) {
  try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* use the environment */ }
  const { logBattleBatch } = await import('./braintrust-battles.mjs');
  console.log(`\nBraintrust: ${(await logBattleBatch(args.tag, rows)).join('  ')}`);
}
console.log(`\nDecision logs for the cross-check:\n${rows.map((r) => r.decisionLog).filter(Boolean).join(' ')}`);
