// Plays Daily Red against RED with the day's team, using Jev (TypeSafe) to
// choose the lead, every move and every switch.
//
//   cd agent && npm install (and cd tests && npm install), with the ROM built (main README)
//   echo TYPESAFE_API_KEY=... > .env   (or export it)
//   node play.mjs                 # today's team, in a Chrome window you can watch
//   node play.mjs --headless      # no window
//   node play.mjs --seed 1234     # another team
//   node play.mjs --policy openai # OpenAI's Decisions API instead of Jev (OPENAI_API_KEY)
//   node play.mjs --policy greedy # no model: always the strongest attack (baseline)
//   node play.mjs --policy search # no model: a 2-turn lookahead in code (stronger baseline)
//   node play.mjs --speed 1       # normal game speed (default 4x fast-forward)
//   node play.mjs --lead Dugtrio  # force the lead instead of asking the model (lead-sweep.mjs)
//   node play.mjs --show-jev      # print every Jev request and response in full
//
// The game runs in practice mode (nothing is recorded as your daily battle).
// Each decision is printed and logged to agent/output/.
import { mkdirSync, appendFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { loadDailyRed } from './dailyred.mjs';
const {
  findChrome, startServer, bootGame, ensureSpeed, waitFor, walkTo, face, press, sleep, screenshot, readMemory,
} = await loadDailyRed('tests/lib.mjs');
const { today, dailySeed } = await loadDailyRed('web/daily.js');
import {
  readBattle, readOwnParty, readPhase, waitForInput, useMove, switchTo, sendIn,
} from './battle.mjs';
import {
  JevBrain, OpenAIBrain, GreedyBrain, SearchBrain, buildRoleItems, roleText, matchup, setOrderCount, setLayout, setFilterFlagged, setDecisionMode, setStateStyle, buildTurnOptions, buildSendInOptions, buildLeadOptions, redTeamFromSource, statusText,
} from './brain.mjs';
import { MOVE_DATA } from './data.mjs';
import { startTrace, describeDecision } from './trace.mjs';

// TYPESAFE_API_KEY can live in agent/.env (git-ignored).
try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* no .env: use the environment */ }

const { values: args } = parseArgs({
  options: {
    seed: { type: 'string' },
    date: { type: 'string' },
    headless: { type: 'boolean', default: false },
    policy: { type: 'string', default: 'jev' },
    model: { type: 'string' },
    screenshots: { type: 'boolean', default: false },
    speed: { type: 'string', default: '4' },
    'show-jev': { type: 'boolean', default: false },
    'no-lead': { type: 'boolean', default: false },
    lead: { type: 'string' },                                  // force this lead (by species name), for measuring leads
    roles: { type: 'string', default: 'sticky' },
    orders: { type: 'string', default: '2' },
    layout: { type: 'string', default: 'consequence' },
    mode: { type: 'string', default: 'choice' },                 // choice | score | hybrid
    'filter-flagged': { type: 'boolean', default: true },        // drop flagged options when a safe one exists
    'no-filter': { type: 'boolean', default: false },            // keep flagged options (the pre-filter behavior)
    state: { type: 'string', default: 'lean' },                  // lean | full (full adds roles, history, other Pokémon)
    trace: { type: 'boolean', default: false },                  // stream the battle to Braintrust Logs
  },
});

const date = args.date ?? today();
const seed = args.seed ? Number(args.seed) : dailySeed(date);
const REQUIRED_KEY = { jev: 'TYPESAFE_API_KEY', openai: 'OPENAI_API_KEY' };
if (!['jev', 'openai', 'greedy', 'search'].includes(args.policy)) {
  console.error(`Unknown --policy ${args.policy}: use jev, openai, greedy or search.`);
  process.exit(1);
}
if (REQUIRED_KEY[args.policy] && !process.env[REQUIRED_KEY[args.policy]]) {
  console.error(`Set ${REQUIRED_KEY[args.policy]} in agent/.env (or run with --policy greedy for the no-model baseline).`);
  process.exit(1);
}
setOrderCount(Number(args.orders));
setLayout(args.layout);
setDecisionMode(args.mode);
setFilterFlagged(args['filter-flagged'] && !args['no-filter']);
setStateStyle(args.state);
const brain = args.policy === 'jev' ? new JevBrain({ model: args.model })
  : args.policy === 'openai' ? new OpenAIBrain({ model: args.model })
  : args.policy === 'search' ? new SearchBrain()
  : new GreedyBrain();

const OUT = new URL('./output/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const runId = `${seed}-${args.policy}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const logFile = `${OUT}/${runId}.jsonl`;
const log = (entry) => appendFileSync(logFile, JSON.stringify(entry) + '\n');

const hp = (m) => `${Math.round((100 * m.hp) / m.maxHp)}%`;
function printDecision(title, options, decision) {
  console.log(`\n${title}`);
  for (const [key, p] of Object.entries(decision.probabilities).slice(0, 4)) {
    const o = options.find((x) => x.key === key);
    console.log(`  ${key === decision.choice ? '→' : ' '} ${(p * 100).toFixed(0).padStart(3)}%  ${o.text.split('. ')[0].replace(/\.$/, '')}`);
  }
  if (decision.reason) console.log(`    reason: ${decision.reason}`);
  if (decision.refused) console.log('    (the model refused twice; used the greedy pick)');
  if (decision.noGoodOption >= 0.5) console.log(`    the model rated "no good option" at ${Math.round(decision.noGoodOption * 100)}%; playing the best real option`);
  if (decision.latencyMs !== undefined) console.log(`    ${args.policy} answered in ${decision.latencyMs} ms`);
  if (decision.outlook !== undefined) {
    const early = decision.tooEarly !== undefined ? ` · too early to tell: ${Math.round(decision.tooEarly * 100)}%` : '';
    console.log(`    outlook ${decision.outlook.toFixed(2)} / 4 (0 losing … 4 winning)${early}`);
  }
  if (args['show-jev'] && decision.request) {
    console.log(`\n--- ${args.policy === 'openai' ? 'OpenAI request (POST /v1/decisions)' : 'Jev request (POST /v1/systemone)'} ---`);
    console.log(JSON.stringify(decision.request, null, 2));
    console.log('--- response ---');
    console.log(JSON.stringify(decision.response, null, 2));
  }
}

// --- Before the battle: choose the lead and put it first via the party menu ----------------
async function reorderLead(page, personality) {
  const party = readOwnParty(await readMemory(page));
  const from = party.findIndex((m) => m?.personality === personality);
  if (from <= 0) return;
  await press(page, 'start'); await sleep(800);
  await press(page, 'a');                                        // POKéMON
  const menu = await waitForPhase(page, 'party');
  for (let i = 0; i < 8 && (await readPhase(page)).partySlot !== from; i++) { await press(page, 'down'); await sleep(200); }
  await press(page, 'a'); await sleep(700);                      // SUMMARY / SWITCH / CANCEL
  await press(page, 'down'); await sleep(300);
  await press(page, 'a'); await sleep(700);                      // SWITCH: now pick the other slot
  await press(page, 'left'); await sleep(300);                   // slot 0 is the big one on the left
  await press(page, 'a'); await sleep(2500);                     // swap animation
  await press(page, 'b'); await sleep(1500);                     // close the party menu
  await press(page, 'b'); await sleep(800);                      // close the start menu
  void menu;
  const after = readOwnParty(await readMemory(page));
  if (after[0]?.personality !== personality) console.warn('  (could not reorder the party; leading with the first Pokémon)');
}

async function waitForPhase(page, phase, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await readPhase(page);
    if (s.phase === phase) return s;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${phase}`);
}

// --- Roles: which Pokémon is reserved for which of RED's, and which are filler ----------
// --roles sticky (default): an assignment is kept until it breaks, and only
// the broken ones are asked again: RED Pokémon with no plan yet, whose planned
// answer fainted, or whose answer no longer wins the one-on-one it won when
// picked (code's matchup). "No good answer" entries are retried when one of
// your Pokémon faints. --roles replan: everything is asked again after any faint.
const plan = new Map(); // RED species -> { answer: personality | null, name, share, wonAtPlan }
let lastOursKey = null;
async function planRoles(ours, reds, activeFoe, field) {
  const oursKey = ours.map((m) => m.personality).join(',');
  const oursChanged = oursKey !== lastOursKey;
  for (const red of [...plan.keys()]) if (!reds.some((r) => r.speciesName === red)) plan.delete(red);

  const need = reds.filter((red) => {
    const entry = plan.get(red.speciesName);
    if (!entry || args.roles === 'replan' && (oursChanged || entry.redsKey !== reds.map((r) => r.speciesName).join(','))) return true;
    if (entry.answer == null) return oursChanged;
    const mon = ours.find((m) => m.personality === entry.answer);
    if (!mon) return true;                                    // the planned answer fainted
    return entry.wonAtPlan && !matchup(mon, red, field).wins;  // it no longer wins the matchup
  });
  lastOursKey = oursKey;

  if (need.length) {
    const items = buildRoleItems(ours, need, field);
    const result = await brain.chooseRoles(ours, reds, items);
    const redsKey = reds.map((r) => r.speciesName).join(',');
    for (const item of items) {
      const pick = result.picks[item.name];
      const option = pick && pick.noGoodOption < 0.5 ? item.options.find((o) => o.key === pick.choice) : null;
      plan.set(item.red.speciesName, {
        answer: option?.mon.personality ?? null, name: option?.mon.speciesName ?? null,
        share: option ? pick.probabilities[pick.choice] : null, wonAtPlan: option?.wins ?? false, redsKey,
      });
    }
    const summary = reds.map((r) => { const e = plan.get(r.speciesName); return `${r.speciesName} → ${e.name ? `${e.name}${need.includes(r) ? ` (${Math.round(100 * e.share)}%)` : ''}` : 'no good answer'}`; });
    console.log(`\nRoles (asked about ${need.map((r) => r.speciesName).join(', ')}): ${summary.join(', ')}`);
    if (result.latencyMs !== undefined) console.log(`    ${args.policy} answered in ${result.latencyMs} ms`);
    log({ type: 'roles', asked: need.map((r) => r.speciesName), plan: Object.fromEntries(plan), picks: result.picks, request: result.request, response: result.response, latencyMs: result.latencyMs });
  }

  // Roles for this turn: answers to the RED Pokémon in battle vs reserved for later.
  const roles = new Map();
  for (const [red, entry] of plan) {
    if (entry.answer == null) continue;
    const role = roles.get(entry.answer) ?? { reservedFor: [], answerTo: [] };
    (red === activeFoe ? role.answerTo : role.reservedFor).push(red);
    roles.set(entry.answer, role);
  }
  return { roles, plan: [...plan].map(([red, e]) => ({ red, answer: e.name, share: e.share })) };
}

// The raw battle behind a decision, so replay.mjs can rebuild its options
// with newer code (roles as [personality, role] pairs).
const snapshot = (battle) => ({
  turn: battle.turn, you: battle.you, foe: battle.foe, bench: battle.bench, foeTeam: battle.foeTeam,
  fainted: battle.fainted, field: battle.field, history: battle.history,
  roles: battle.roles ? [...battle.roles] : null, noAnswerTo: battle.noAnswerTo ?? null,
});

// --- Main ----------------------------------------------------------------------------------------
const server = await startServer();
const browser = await chromium.launch({
  executablePath: findChrome(),
  headless: args.headless,
  args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 520, height: 390 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let outcome = 0;
let redFainted = 0; // RED's Pokémon knocked out so far, for the trace
const tracer = startTrace({
  enabled: args.trace, brain, policy: args.policy,
  name: `battle · ${args.seed ? seed : 'today'} · ${args.policy}`,
  input: { seed, date, policy: args.policy },
  metadata: { policy: args.policy, team: args.seed ?? 'today', mode: args.mode, layout: args.layout, orders: Number(args.orders), roles: args.roles, filter_flagged: args['filter-flagged'] && !args['no-filter'], state: args.state },
});
const traceMeta = { policy: args.policy, team: args.seed ?? 'today' };
try {
  console.log(`Daily Red agent: ${args.seed ? `seed ${seed}` : `${date} (seed ${seed})`}, policy ${args.policy}, speed ${args.speed}x`);
  await bootGame(page, server.url, { seed, speed: Number(args.speed) });
  // Label the window (URL, title and a line above the game) so several runs
  // side by side can be told apart.
  const model = args.policy === 'greedy' ? null : brain.model ?? brain.client?.defaultModel;
  const query = new URLSearchParams({ seed: String(seed), ...(args.seed ? {} : { date }), policy: args.policy, ...(model ? { model } : {}) });
  const label = `${args.seed ? `seed ${seed}` : `${date} (seed ${seed})`} · ${args.policy}${model ? ` (${model})` : ''}`;
  await page.evaluate(({ query, label }) => {
    history.replaceState(null, '', `${location.pathname}?${query}`);
    document.title = label;
    const tag = document.createElement('div');
    tag.textContent = label;
    tag.style.cssText = 'font: 13px/1.6 system-ui, sans-serif; padding: 2px 6px; background: #222; color: #eee;';
    document.body.style.margin = '0';
    document.body.prepend(tag);
  }, { query: query.toString(), label });
  const start = await waitFor(page, (st) => st.inOverworld, { what: 'overworld', timeoutMs: 60000 });
  const fps = await ensureSpeed(page, Number(args.speed));
  console.log(`Emulator: ${fps.toFixed(0)} frames/s (${(fps / 59.73).toFixed(1)}x normal speed)`);
  const party = readOwnParty(start.mem).filter(Boolean);
  console.log(`Team: ${party.map((m) => m.speciesName).join(', ')}`);
  log({ type: 'team', seed, date, party: party.map((m) => m.speciesName) });

  const redTeam = redTeamFromSource();
  const { roles: preRoles } = await planRoles(party, redTeam, redTeam[0].speciesName, { weather: {}, playerSide: {}, foeSide: {} });
  if (!args['no-lead']) {
    const options = buildLeadOptions(party, redTeam, preRoles);
    const forced = args.lead && options.find((o) => o.mon.speciesName.toLowerCase() === args.lead.toLowerCase());
    if (args.lead && !forced) throw new Error(`--lead ${args.lead}: not in the party (${party.map((m) => m.speciesName).join(', ')})`);
    const decision = forced ? { choice: forced.key, probabilities: { [forced.key]: 1 }, forced: true }
      : await tracer.span('lead', () => brain.chooseLead(party, redTeam, options), (d) => describeDecision('lead', 0, options, d, traceMeta));
    printDecision(`Lead vs RED's ${redTeam[0].speciesName}`, options, decision);
    log({ type: 'lead', options: options.map((o) => ({ key: o.key, text: o.text })), decision });
    await sleep(1000);
    await reorderLead(page, options.find((o) => o.key === decision.choice).personality);
  }

  // Climb to RED and talk to him.
  await walkTo(page, [[9, 12]]);
  await face(page, 'up');
  for (let i = 0; i < 25 && (await readPhase(page)).phase === 'overworld'; i++) { await press(page, 'a'); await sleep(500); }

  const history = []; // { turn, text, switchedOut } for the turns played so far
  let lastPick = null; // the move picked last turn, checked against what the game ran
  let excluded = new Set();
  let lastTurn = -1;
  for (;;) {
    const s = await waitForInput(page);
    if (s.phase === 'over' || s.phase === 'overworld') { outcome = s.outcome; break; }
    if (s.phase === 'move') { await press(page, 'b'); continue; } // stray FIGHT menu: back out
    const battle = { ...readBattle(s.mem), history };
    if (battle.unreadable) { await sleep(400); continue; } // party data mid-update: read again
    redFainted = battle.foeTeam.filter((m) => m.hp === 0).length;
    const planned = await planRoles(
      [battle.you, ...battle.bench].filter((m) => m.hp > 0),
      // RED's active Pokémon as it is in battle (boosts included), the rest from his party.
      battle.foeTeam.filter((m) => m.hp > 0).map((m) => (m.active ? battle.foe : m)),
      battle.foe.speciesName,
      battle.field,
    );
    battle.roles = planned.roles;
    // The role planner found no good answer to the Pokémon in battle.
    if (planned.plan.some((p) => p.red === battle.foe.speciesName && !p.answer)) battle.noAnswerTo = battle.foe.speciesName;
    if (battle.turn !== lastTurn) { excluded = new Set(); lastTurn = battle.turn; }
    // Did the game run the move that was picked? (gLastMoves; only checkable
    // while the same Pokémon is still in and a turn has passed.)
    if (lastPick && battle.turn > lastPick.turn && battle.you.personality === lastPick.personality
        && battle.you.lastMove && battle.you.lastMove !== 0xFFFF && battle.you.lastMove !== lastPick.moveId) {
      const msg = `picked ${MOVE_DATA.get(lastPick.moveId).name} on turn ${lastPick.turn} but the game ran ${MOVE_DATA.get(battle.you.lastMove)?.name ?? battle.you.lastMove}`;
      console.log(`    WARNING: ${msg}`);
      log({ type: 'move_mismatch', turn: lastPick.turn, picked: lastPick.moveId, ran: battle.you.lastMove });
    }
    if (lastPick && battle.turn > lastPick.turn) lastPick = null;
    if (args.screenshots) await screenshot(page, `${OUT}/${runId}-t${battle.turn}-${s.phase}.png`);

    if (s.phase === 'party') {
      const options = buildSendInOptions(battle);
      const decision = await tracer.span(`turn ${battle.turn} · send-in`, () => brain.chooseSendIn(battle, options), (d) => describeDecision('send_in', battle.turn, options, d, traceMeta));
      printDecision(`Turn ${battle.turn}: send in a Pokémon vs RED's ${battle.foe.speciesName} (${hp(battle.foe)})`, options, decision);
      log({ type: 'send_in', turn: battle.turn, options: options.map((o) => ({ key: o.key, text: o.text })), decision, raw: snapshot(battle) });
      const pick = options.find((o) => o.key === decision.choice);
      await sendIn(page, pick.personality);
      history.push({ turn: battle.turn, text: `Turn ${battle.turn}: ${battle.you.speciesName} fainted; you sent in ${pick.mon.speciesName}.` });
      continue;
    }

    // phase === 'action'
    const { you, foe } = battle;
    const options = buildTurnOptions(battle, excluded, history);
    if (!options.length) { await useMove(page, 0); continue; } // nothing legal left: Struggle
    const decision = await tracer.span(`turn ${battle.turn} · action`, () => brain.chooseAction(battle, options), (d) => describeDecision('action', battle.turn, options, d, traceMeta));
    printDecision(`Turn ${battle.turn}: ${you.speciesName} ${hp(you)} ${statusText(you.status1)} vs RED's ${foe.speciesName} ${hp(foe)} ${statusText(foe.status1)}`, options, decision);
    log({ type: 'action', turn: battle.turn, you: you.speciesName, foe: foe.speciesName, options: options.map((o) => ({ key: o.key, text: o.text })), decision, raw: snapshot(battle), excluded: [...excluded] });
    const chosen = options.find((o) => o.key === decision.choice);
    const accepted = chosen.kind === 'move' ? await useMove(page, chosen.slot) : await switchTo(page, chosen.personality);
    if (accepted && chosen.kind === 'move') lastPick = { turn: battle.turn, personality: you.personality, moveId: chosen.moveId };
    if (accepted) {
      history.push(chosen.kind === 'move'
        ? { turn: battle.turn, text: `Turn ${battle.turn}: ${you.speciesName} used ${MOVE_DATA.get(chosen.moveId).name} against ${foe.speciesName}.` }
        : { turn: battle.turn, text: `Turn ${battle.turn}: you switched ${you.speciesName} out for ${chosen.mon.speciesName}.`, switchedOut: you.personality });
    } else {
      console.log(`    the game refused ${chosen.key}; asking again without it`);
      excluded.add(chosen.key);
    }
  }
} catch (e) {
  // Print the error before the cleanup below exits the process (which would hide it).
  console.error(`Error: ${e.stack ?? e}`);
  log({ type: 'error', message: String(e.stack ?? e) });
} finally {
  const result = outcome === 1 ? 'WON' : outcome === 2 ? 'LOST' : 'did not finish';
  console.log(`\nResult: ${result} against RED.`);
  if (brain.usage) {
    const u = brain.usage;
    console.log(`${args.policy === 'openai' ? 'OpenAI' : 'Jev'} usage: ${u.requests} requests, ${u.input_tokens} input / ${u.output_tokens} output tokens${u.refusals ? `, ${u.refusals} refusals` : ''}`);
    if (u.latencies.length) {
      const sorted = [...u.latencies].sort((a, b) => a - b);
      const total = sorted.reduce((a, b) => a + b, 0);
      console.log(`Latency: avg ${Math.round(total / sorted.length)} ms, median ${sorted[Math.floor(sorted.length / 2)]} ms, slowest ${sorted.at(-1)} ms, ${(total / 1000).toFixed(1)} s waiting in total`);
    }
  }
  console.log(`Decision log: ${logFile}`);
  log({ type: 'result', outcome: result, usage: brain.usage });
  const redKo = outcome === 1 ? 6 : redFainted;
  await tracer.finish({
    output: { result, red_knocked_out: redKo },
    scores: { won: outcome === 1 ? 1 : 0, red_knocked_out: redKo / 6 },
    metrics: { prompt_tokens: brain.usage?.input_tokens ?? 0, completion_tokens: brain.usage?.output_tokens ?? 0 },
  });
  if (!args.headless && outcome) await sleep(5000);
  // Closing a visible browser can hang; don't let it keep the process alive
  // (experiment.mjs waits for each battle to exit).
  await Promise.race([browser.close().catch(() => {}), sleep(5000)]);
  server.close();
  process.exit(outcome ? 0 : 1);
}
