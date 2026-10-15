// Decision test suite: hand-built situations with a known right answer,
// checked without the emulator.
//
//   node decision-tests.mjs --prompts-only        # option text checks, no model calls (free, instant)
//   node decision-tests.mjs --policy jev          # also ask Jev for each decision
//   node decision-tests.mjs --policy both --repeat 3
//   node decision-tests.mjs --show                # print every option the model would see
//
// Exits non-zero when a check fails, so it can gate changes to brain.mjs.
// Uses the agent's defaults: consequence-first layout, flagged options
// filtered, lean state, 2 option orders (override with --layout, --no-filter,
// --state, --orders).
import { parseArgs } from 'node:util';
import {
  JevBrain, OpenAIBrain, buildTurnOptions, buildSendInOptions, buildLeadOptions, redTeamFromSource, turnState,
  ACTION_QUESTION, SEND_IN_QUESTION, decide, setLayout, setFilterFlagged, setStateStyle, setOrderCount, setOptionFormat,
} from './brain.mjs';
import cases from './decision-tests/cases.mjs';

const RED_TEAM = redTeamFromSource();

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* use the environment */ }

const { values: args } = parseArgs({
  options: {
    policy: { type: 'string', default: 'none' },     // none | jev | openai | both
    repeat: { type: 'string', default: '1' },
    'prompts-only': { type: 'boolean', default: false },
    show: { type: 'boolean', default: false },
    only: { type: 'string' },                         // run cases whose name contains this
    layout: { type: 'string', default: 'consequence' },
    'no-filter': { type: 'boolean', default: false },
    state: { type: 'string', default: 'lean' },
    orders: { type: 'string', default: '2' },
    options: { type: 'string', default: 'text' },               // text | json (Jev: options as prose or as JSON fields)
  },
});
setLayout(args.layout);
setFilterFlagged(!args['no-filter']);
setStateStyle(args.state);
setOptionFormat(args.options);
setOrderCount(Number(args.orders));

const policies = args['prompts-only'] ? [] : args.policy === 'both' ? ['jev', 'openai'] : args.policy === 'none' ? [] : [args.policy];
const brains = Object.fromEntries(policies.map((p) => [p, p === 'jev' ? new JevBrain() : new OpenAIBrain()]));
const selected = cases.filter((c) => !args.only || c.name.includes(args.only));

let failures = 0;
const results = [];
for (const c of selected) {
  const battle = c.type === 'lead' ? null : c.battle();
  const party = c.type === 'lead' ? c.party() : null;
  setFilterFlagged(c.filter ?? !args['no-filter']);
  const options = c.type === 'lead' ? buildLeadOptions(party, RED_TEAM, null)
    : c.type === 'send_in' ? buildSendInOptions(battle) : buildTurnOptions(battle);
  const byKey = new Map(options.map((o) => [o.key, o]));
  console.log(`\n${c.name}`);
  if (args.show) for (const o of options) console.log(`    ${o.key}: ${o.text}`);

  // 1. The prompt: does the option text say what it must?
  for (const check of c.prompt ?? []) {
    const o = byKey.get(check.option);
    const ok = check.absent ? !o : !!o && check.contains.test(o.text);
    const what = check.absent ? `${check.option} not offered` : `${check.option} says ${check.contains}`;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  prompt: ${what}${!ok && !check.absent && !o ? ' (option missing)' : ''}`);
    if (!ok) failures++;
  }
  // The shared state: does it say what it must? (e.g. the threat board)
  if (c.state?.length) {
    const text = JSON.stringify(turnState(battle));
    for (const re of c.state) {
      const ok = re.test(text);
      console.log(`  ${ok ? 'PASS' : 'FAIL'}  state says ${re}`);
      if (!ok) failures++;
    }
  }
  // The expected answers must actually be on offer, or the case is broken.
  // A case without an expected answer only checks the prompt (e.g. a lead
  // still waiting for a measured best answer from lead-sweep.mjs).
  if (!c.expect) { if (Object.keys(brains).length) console.log('  note  no expected answer yet: prompt checks only'); continue; }
  for (const key of c.expect.pick ?? []) {
    if (!byKey.has(key)) { console.log(`  FAIL  case: expected option ${key} is not offered (${[...byKey.keys()].join(', ')})`); failures++; }
  }

  // 2. The decision: does the model choose right? (One option left = decided by code.)
  if (options.length < 2 && Object.keys(brains).length) console.log('  note  only one option on offer: decided by code, not the model');
  const question = c.type === 'send_in' ? SEND_IN_QUESTION : ACTION_QUESTION;
  for (const [policy, brain] of Object.entries(brains)) {
    let right = 0;
    const picks = [];
    for (let i = 0; i < Number(args.repeat); i++) {
      const answer = c.type === 'lead' ? await brain.chooseLead(party, RED_TEAM, options) : await decide(brain, turnState(battle), question, options);
      const ok = c.expect.pick ? c.expect.pick.includes(answer.choice) : !c.expect.avoid.includes(answer.choice);
      if (ok) right++;
      picks.push(`${answer.choice} ${Math.round(100 * (answer.probabilities[answer.choice] ?? 0))}%`);
    }
    const ok = right === Number(args.repeat);
    if (!ok) failures++;
    results.push({ case: c.name, policy, right, of: Number(args.repeat) });
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${policy}: ${right}/${args.repeat} right (picked ${picks.join(', ')}; expected ${c.expect.pick ? `one of ${c.expect.pick.join(', ')}` : `not ${c.expect.avoid.join(', ')}`})`);
    if (!ok) console.log(`        why: ${c.why}`);
  }
}

if (results.length) {
  console.log('\nModel scores:');
  for (const p of policies) {
    const r = results.filter((x) => x.policy === p);
    console.log(`  ${p}: ${r.filter((x) => x.right === x.of).length}/${r.length} cases always right`);
  }
}
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
