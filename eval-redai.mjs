// Checks redai.mjs against what RED actually did in logged battles: for each
// logged turn where the same RED Pokémon is still out next turn and could act,
// the move it used is read from the next snapshot. Compares the AI port with
// "RED uses its strongest attack" (what the option text assumed before).
//
//   node eval-redai.mjs                # every decision log in output/
//   node eval-redai.mjs exchange final # only these batches
import { readFileSync, readdirSync } from 'node:fs';
import { predictRedMove } from './redai.mjs';
import { estimateDamage } from './damage.mjs';
import { MOVE_DATA } from './data.mjs';

const dir = new URL('./output/', import.meta.url).pathname;
const tags = process.argv.slice(2);
const files = tags.length
  ? tags.flatMap((t) => JSON.parse(readFileSync(`${dir}${t}-summary.json`, 'utf8')).map((r) => r.decisionLog).filter(Boolean))
  : readdirSync(dir).filter((f) => /^\d+-(jev|openai|greedy|search)-.*\.jsonl$/.test(f)).map((f) => dir + f);

const strongest = (red, you, field) => {
  let best = null;
  for (const id of red.moves.filter(Boolean)) {
    const est = estimateDamage(id, red, you, { weather: field.weather ?? {}, defenderScreens: field.playerSide ?? {} });
    const avg = est && !est.unknown ? (est.min + est.max) / 2 : 0;
    if (!best || avg > best.avg) best = { id, avg };
  }
  return best?.id;
};

let n = 0, top1 = 0, base = 0, logLik = 0, pSum = 0;
const misses = new Map();
for (const file of files) {
  let L;
  try { L = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse); } catch { continue; }
  const acts = L.filter((l) => l.type === 'action' && l.raw);
  for (let i = 0; i + 1 < acts.length; i++) {
    const a = acts[i].raw, b = acts[i + 1].raw;
    if (b.turn !== a.turn + 1 || b.foe.personality !== a.foe.personality) continue; // RED switched or a faint
    if (a.foe.status1 & 0x7 || a.foe.status1 & 0x20 || a.foe.status1 & 0x40) continue;   // asleep or frozen or paralyzed (may not act)
    const used = b.foe.lastMove;
    if (!used || !a.foe.moves.includes(used)) continue;
    const field = a.field ?? {};
    const pred = predictRedMove(a.foe, a.you, field, 200);
    n++;
    if (pred[0]?.id === used) top1++;
    if (strongest(a.foe, a.you, field) === used) base++;
    pSum += pred.find((p) => p.id === used)?.p ?? 0;
    logLik += Math.log(Math.max(0.02, pred.find((p) => p.id === used)?.p ?? 0));
    if (pred[0]?.id !== used) {
      const key = `${a.foe.speciesName}: predicted ${pred[0]?.name}, used ${MOVE_DATA.get(used).name}`;
      misses.set(key, (misses.get(key) ?? 0) + 1);
    }
  }
}
console.log(`${n} RED moves from ${files.length} logs`);
console.log(`  AI port, top pick right:      ${Math.round((100 * top1) / n)}%`);
console.log(`  "strongest attack", right:    ${Math.round((100 * base) / n)}%`);
console.log(`  AI port, average probability on the move RED used: ${Math.round((100 * pSum) / n)}% ("strongest attack" puts 100% on one move: ${Math.round((100 * base) / n)}%)`);
console.log(`  AI port, mean log-likelihood: ${(logLik / n).toFixed(2)}`);
console.log('Most common misses:');
for (const [k, c] of [...misses].sort((x, y) => y[1] - x[1]).slice(0, 15)) console.log(`  ${c}  ${k}`);
