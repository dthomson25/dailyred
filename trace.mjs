// Live tracing to Braintrust Logs (play.mjs --trace): one trace per battle,
// a span per decision, and the model's API calls nested under it through
// Braintrust's TypeSafe and OpenAI client wrappers. Tracing problems never
// stop a battle: on any error it turns itself off.
import { initLogger, wrapTypeSafe, wrapOpenAI } from 'braintrust';

const OFF = { span: (name, fn) => fn(), finish: async () => {} };

const kindOf = (key, text) => (key.startsWith('switch_') ? 'switch' : key.startsWith('send_') ? 'send-in' : key.startsWith('lead_') ? 'lead'
  : /Use (Protect|Detect|Endure)/.test(text) ? 'protect' : /status move/.test(text) ? 'status' : 'attack');
const labelOf = (text) => text.match(/(?:Use|Switch out to|Send in|Lead with) ([^(.]+?) \(/)?.[1] ?? text.slice(0, 40);
const FLAGGED = /^(Wasted|Will fail|Unreliable|Faints before attacking):|Danger: |Warning: /;

// What a decision span records.
export function describeDecision(type, turn, options, decision, meta = {}) {
  const req = decision.request;
  const state = req?.state ?? (typeof req?.input === 'string' ? JSON.parse(req.input) : null);
  const pick = options.find((o) => o.key === decision.choice);
  return {
    input: { state, options: options.map((o) => ({ key: o.key, text: o.text })) },
    output: { choice: decision.choice, pick: pick?.text, probabilities: decision.probabilities, no_good_option: decision.noGoodOption, outlook: decision.outlook },
    metrics: {
      prompt_tokens: decision.response?.usage?.input_tokens ?? 0, completion_tokens: decision.response?.usage?.output_tokens ?? 0,
      ...(typeof decision.outlook === 'number' ? { outlook: decision.outlook } : {}),
      ...(typeof decision.outlookConfidence === 'number' ? { outlook_confidence: decision.outlookConfidence } : {}),
      ...(typeof decision.tooEarly === 'number' ? { too_early: decision.tooEarly } : {}),
    },
    metadata: {
      ...meta, decision_type: type, turn,
      position: state?.your_active_pokemon ? `${state.your_active_pokemon.pokemon} ${state.your_active_pokemon.hp.split(' ')[0]} vs ${state.red_active_pokemon.pokemon} ${state.red_active_pokemon.hp.split(' ')[0]}` : type,
      pick_label: pick ? labelOf(pick.text) : null, pick_kind: pick ? kindOf(pick.key, pick.text) : null,
      latency_ms: decision.latencyMs ?? null, filtered_out: decision.filteredOut ?? null,
    },
    tags: [...(meta.policy ? [meta.policy] : []), ...(pick && FLAGGED.test(pick.text) ? ['flagged-pick'] : [])],
  };
}

export function startTrace({ enabled, name, input, metadata, brain, policy }) {
  if (!enabled) return OFF;
  try {
    const logger = initLogger({ projectName: 'daily-red-agent' });
    if (policy === 'jev' && brain.client) brain.client = wrapTypeSafe(brain.client);
    if (policy === 'openai' && brain.client) brain.client = wrapOpenAI(brain.client);
    const root = logger.startSpan({ name, type: 'task' });
    root.log({ input, metadata, tags: [policy] });
    let on = true;
    return {
      // Runs fn inside a decision span (so wrapped API calls nest under it) and logs describe(result).
      span: (spanName, fn, describe) => (!on ? fn() : root.traced(async (span) => {
        const result = await fn();
        try { span.log(describe(result)); } catch (e) { on = false; console.log(`    (tracing off: ${e.message})`); }
        return result;
      }, { name: spanName, type: 'llm' })),
      finish: async (args) => {
        try { root.log(args); root.end(); await logger.flush(); } catch (e) { console.log(`    (tracing flush failed: ${e.message})`); }
      },
    };
  } catch (e) {
    console.log(`(tracing off: ${e.message})`);
    return OFF;
  }
}
