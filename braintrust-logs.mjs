// Sends finished battles to Braintrust's Logs (not Experiments): one trace per
// battle, with a span per decision holding the state, options, pick,
// probabilities and latency. Built from the decision logs, so past battles
// show up the way live ones will once play.mjs traces itself.
//
//   node braintrust-logs.mjs exp4x-v8            # every battle in a batch
//   node braintrust-logs.mjs output/x.jsonl ...  # specific decision logs
import { readFileSync } from 'node:fs';
import { initLogger } from 'braintrust';

try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* use the environment */ }

const logger = initLogger({ projectName: 'daily-red-agent' });

// Decision logs named on the command line, or every battle of a batch.
const files = process.argv.slice(2).flatMap((arg) => (arg.endsWith('.jsonl') ? [arg]
  : JSON.parse(readFileSync(new URL(`./output/${arg}-summary.json`, import.meta.url), 'utf8')).map((r) => r.decisionLog).filter(Boolean)));

const kindOf = (key, text) => (key.startsWith('switch_') ? 'switch' : key.startsWith('send_') ? 'send-in' : key.startsWith('lead_') ? 'lead'
  : /Use (Protect|Detect|Endure)/.test(text) ? 'protect' : /status move/.test(text) ? 'status' : 'attack');
const labelOf = (text) => text.match(/(?:Use|Switch out to|Send in|Lead with) ([^(.]+?) \(/)?.[1] ?? text.slice(0, 40);

for (const file of files) {
  const L = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const name = file.split('/').pop().replace('.jsonl', '');
  const [seed, policy, ...stamp] = name.split('-');
  const team = L.find((l) => l.type === 'team');
  const result = L.find((l) => l.type === 'result');
  const decisions = L.filter((l) => ['lead', 'action', 'send_in'].includes(l.type));
  const lastState = [...decisions].reverse().map((l) => l.decision.request?.state ?? (l.decision.request?.input && JSON.parse(l.decision.request.input))).find((s) => s?.red_other_pokemon);
  const redKo = result?.outcome === 'WON' ? 6 : lastState ? lastState.red_other_pokemon.filter((x) => x.includes('fainted')).length : null;

  const battle = logger.startSpan({ name: `battle · ${seed === '4109215006' ? 'today' : seed} · ${policy}`, type: 'task' });
  battle.log({
    input: { seed, team: team?.party, policy },
    output: { result: result?.outcome, red_knocked_out: redKo, decisions: decisions.length },
    scores: { won: result?.outcome === 'WON' ? 1 : 0, ...(redKo != null ? { red_knocked_out: redKo / 6 } : {}) },
    metrics: { tokens: result?.usage?.input_tokens ?? 0, prompt_tokens: result?.usage?.input_tokens ?? 0, completion_tokens: result?.usage?.output_tokens ?? 0 },
    metadata: { policy, team: seed === '4109215006' ? 'today' : seed, log: name, started: stamp.join('-') },
    tags: [policy, result?.outcome === 'WON' ? 'won' : 'lost'],
  });
  for (const l of decisions) {
    const req = l.decision.request;
    const state = req?.state ?? (req?.input ? JSON.parse(req.input) : null);
    const pick = l.options.find((o) => o.key === l.decision.choice);
    const span = battle.startSpan({ name: `${l.type === 'lead' ? 'lead' : `turn ${l.turn}`} · ${l.type === 'send_in' ? 'send-in' : l.type}`, type: 'llm' });
    const flaggedPick = /^(Wasted|Will fail|Unreliable|Faints before attacking):|Danger: |Warning: /.test(pick?.text ?? '');
    span.log({
      input: { state, options: l.options },
      output: { choice: l.decision.choice, pick: pick?.text, probabilities: l.decision.probabilities, no_good_option: l.decision.noGoodOption, outlook: l.decision.outlook },
      metrics: { prompt_tokens: l.decision.response?.usage?.input_tokens ?? 0, completion_tokens: l.decision.response?.usage?.output_tokens ?? 0 },
      metadata: {
        policy, team: seed === '4109215006' ? 'today' : seed, decision_type: l.type, turn: l.turn ?? 0,
        position: state?.your_active_pokemon ? `${state.your_active_pokemon.pokemon} ${state.your_active_pokemon.hp.split(' ')[0]} vs ${state.red_active_pokemon.pokemon} ${state.red_active_pokemon.hp.split(' ')[0]}` : 'lead',
        pick_label: pick ? labelOf(pick.text) : null, pick_kind: pick ? kindOf(pick.key, pick.text) : null,
        latency_ms: l.decision.latencyMs ?? null, model: l.decision.model ?? null,
      },
      tags: [policy, ...(flaggedPick ? ['flagged-pick'] : [])],
    });
    span.end();
  }
  battle.end();
  console.log(`${name}: ${decisions.length} decisions, ${result?.outcome ?? 'unfinished'}`);
}
await logger.flush();
console.log(`Sent ${files.length} battles to Braintrust Logs (project daily-red-agent).`);
