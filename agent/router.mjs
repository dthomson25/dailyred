// Confidence routing (play.mjs --policy route): Jev makes every decision, and
// only close calls go to OpenAI's Decisions API. A decision is a close call
// when Jev's top option gets less than ROUTE_BELOW of the probability (after
// averaging option orders). Answers what a second model is worth when it is
// only paid for on the decisions the first one is unsure about.
import { JevBrain, OpenAIBrain } from './brain.mjs';

export const ROUTE_BELOW = Number(process.env.ROUTE_BELOW ?? 0.4);

export class RouterBrain {
  constructor({ model } = {}) {
    this.jev = new JevBrain({ model });
    this.openai = new OpenAIBrain();
    this.client = this.jev.client; // for tracing and the "model" line
    this.routed = { decisions: 0, escalated: 0 };
  }

  get usage() {
    const a = this.jev.usage, b = this.openai.usage;
    return {
      input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens,
      requests: a.requests + b.requests, latencies: [...a.latencies, ...b.latencies],
      jev: { ...a }, openai: { ...b }, routed: { ...this.routed },
    };
  }

  // Jev first; OpenAI's answer replaces it on a close call. Both are kept in the log.
  async route(kind, args) {
    const first = await this.jev[kind](...args);
    this.routed.decisions++;
    const top = Math.max(0, ...Object.values(first.probabilities ?? {}));
    if (first.single || top >= ROUTE_BELOW) return { ...first, routedTo: 'jev', jevTop: top };
    this.routed.escalated++;
    try {
      const second = await this.openai[kind](...args);
      return { ...second, routedTo: 'openai', jevTop: top, jevChoice: first.choice, jevProbabilities: first.probabilities, outlook: first.outlook, tooEarly: first.tooEarly, outlookConfidence: first.outlookConfidence };
    } catch (e) {
      // OpenAI unavailable (refusal, credits): keep Jev's answer.
      return { ...first, routedTo: 'jev (openai failed)', jevTop: top, routeError: e.message };
    }
  }

  chooseAction(battle, options) { return this.route('chooseAction', [battle, options]); }
  chooseSendIn(battle, options) { return this.route('chooseSendIn', [battle, options]); }
  chooseLead(party, redTeam, options) { return this.route('chooseLead', [party, redTeam, options]); }
  chooseRoles(ours, reds, items) { return this.jev.chooseRoles(ours, reds, items); }
}
