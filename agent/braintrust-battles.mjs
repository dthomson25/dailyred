// Logs live battle batches to Braintrust: one experiment per batch and model,
// one row per battle, scored by the share of RED's Pokémon knocked out and
// whether the battle was won. Lets the project's experiment list show results
// across every version of the agent.
//
//   node braintrust-battles.mjs                    # backfill every 4x batch so far
//   node braintrust-battles.mjs exp4x-v8           # one batch
//
// experiment.mjs --braintrust calls logBattleBatch() for new batches.
import { readFileSync, statSync } from 'node:fs';
import { init as initBraintrust } from 'braintrust';

// What each batch changed, shown as the experiment's description.
export const BATCH_NOTES = {
  'exp4x': { version: 'v1', change: '4 teams at real 4x speed; reserved/filler roles re-planned after every faint; Perish Song stalling; "none of these" option' },
  'exp4x-v2': { version: 'v2', change: '+ HP never shown as 0%; "no damaging moves left" note and tank switches; Protect capped at 25%; "no answer" note' },
  'exp4x-v3': { version: 'v3', change: '+ filler Pokémon may be left to faint for a free send-in' },
  'exp4x-v4': { version: 'v4', change: '+ Toxic, stat-boost and speed simulations; contact abilities; accuracy-adjusted knockouts; 3 rounds' },
  'exp4x-v5': { version: 'v5', change: '+ sticky roles (re-asked only when broken)' },
  'exp4x-v6': { version: 'v6', change: '+ 4 option orders instead of 2' },
  'exp4x-v7': { version: 'v7', change: 'back to 2 orders; + consequence-first option layout' },
  'exp4x-v8': { version: 'v8', change: '+ Hyper Beam recharge cost and overkill priced' },
  'noise': { version: 'noise', change: 'v8 setup repeated 6 times per model on two teams, to measure battle-to-battle luck' },
  'night-control': { version: 'night control', change: 'current setup (consequence-first, recharge/overkill priced, sticky roles, 2 orders), 6 rounds' },
  'night-filter': { version: 'night filter', change: 'control + flagged options removed in code when a safe option exists' },
  'night-hybrid': { version: 'night hybrid', change: 'control + hybrid decisions: a Score per option drops mistakes, then a Choice among the rest' },
  'night-teams': { version: 'night new teams', change: 'control setup on 10 teams never used before, 1 battle each' },
  'confirm': { version: 'confirm defaults', change: 'new defaults: night-control + flagged options removed in code + lean state' },
  'final': { version: 'final', change: 'defaults + consequence-first lead options (accuracy, who attacks first, role cost), cursor fix, too-early-to-tell question' },
  'exchange': { version: 'exchange', change: 'final + knockout risks split into certain (70%+, filtered) and Risky (30-70%, kept); one-on-one Exchange line on send-ins and switches; Attract gender check; seeds pinned' },
  'heal': { version: 'heal-aware roles', change: 'exchange + roles chosen from the same one-on-one simulation; RED heals in the simulation as FireRed AI does (Rest, Morning Sun thresholds)' },
  'redai': { version: 'RED AI model', change: "RED's moves predicted with a port of FireRed's AI (75% right vs 64% for strongest attack); danger summed over its likely moves; one-on-ones simulated 200 times with sleep, Leech Seed, healing; roles chosen by win chance" },
  'leadcost': { version: 'lead cost', change: 'RED AI model + lead options state lead exchange, later value and a computed lead cost (later win chances after the lead); charge turns and recoil simulated' },
  'ppboost': { version: 'PP and boosts', change: 'lead cost + one-on-one simulation tracks PP (falls back to the next attack) and RED stat boosts (Calm Mind etc.)' },
  'leadfix': { version: 'lead fix', change: 'PP and boosts + role-based Cost/Benefit headlines removed from lead options (they contradicted the computed lead cost)' },
  'nextfoe': { version: 'next foe', change: "lead fix + lead options say which Pokémon RED's AI sends in next against that lead (port of its switch-in choice, 84% right) and whether the team has an answer to it" },
  'setup': { version: 'setup plans', change: "next foe + setup moves (Swords Dance, Calm Mind, Toxic) compared with attacking right away, both simulated with RED's AI (Rest, healing)" },
  'baselines': { version: 'baselines', change: 'no-model policies on the v8 setup: greedy (strongest attack) and a 2-turn lookahead search in code' },
};

// Battle-level facts from a decision log.
function battleStats(decisionLog) {
  const L = readFileSync(decisionLog, 'utf8').trim().split('\n').map(JSON.parse);
  const actions = L.filter((l) => l.type === 'action');
  const pickText = (l) => l.options.find((o) => o.key === l.decision.choice)?.text ?? '';
  const share = (f) => (actions.length ? actions.filter(f).length / actions.length : 0);
  const lead = L.find((l) => l.type === 'lead');
  return {
    lead: lead ? pickText(lead).split(' (')[0].replace('Lead with ', '') : null,
    switch_rate: share((l) => l.decision.choice.startsWith('switch_')),
    protect_rate: share((l) => /Use (Protect|Detect|Endure)/.test(pickText(l))),
    hyper_beam_uses: actions.filter((l) => /must rest next turn/.test(pickText(l))).length,
    send_ins: L.filter((l) => l.type === 'send_in').length,
    // The model's own "how is the battle going" score (0 losing ... 4 winning), to check against the result.
    ...outlookStats(actions),
  };
}

function outlookStats(actions) {
  const o = actions.map((l) => l.decision?.outlook).filter((x) => typeof x === 'number');
  if (!o.length) return {};
  const early = actions.map((l) => l.decision?.tooEarly).filter((x) => typeof x === 'number');
  // The first turn the model no longer thinks it's too early to tell (below 50%).
  const called = actions.find((l) => typeof l.decision?.tooEarly === 'number' && l.decision.tooEarly < 0.5);
  return {
    outlook_first: o[0], outlook_mid: o[Math.floor(o.length / 2)], outlook_mean: o.reduce((a, b) => a + b, 0) / o.length,
    ...(early.length ? { too_early_first: early[0], too_early_mean: early.reduce((a, b) => a + b, 0) / early.length, first_called_turn: called?.turn ?? null } : {}),
  };
}

// Duration and tokens for Braintrust's columns: the battle starts at the time in
// its decision log's name (…-2026-10-14T05-17-11-554Z.jsonl) and ends when the
// log was last written.
function battleMetrics(r) {
  const metrics = {
    prompt_tokens: r.inputTokens ?? 0,
    completion_tokens: r.outputTokens ?? 0,
    tokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
  };
  const stamp = r.decisionLog?.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.jsonl$/);
  if (stamp) {
    const start = Date.parse(`${stamp[1]}T${stamp[2]}:${stamp[3]}:${stamp[4]}.${stamp[5]}Z`) / 1000;
    try { metrics.start = start; metrics.end = statSync(r.decisionLog).mtimeMs / 1000; } catch { /* log moved: no duration */ }
  }
  return metrics;
}

export async function logBattleBatch(tag, rows) {
  const note = BATCH_NOTES[tag] ?? { version: tag, change: '' };
  const urls = [];
  for (const policy of [...new Set(rows.map((r) => r.policy))]) {
    const experiment = initBraintrust({
      project: 'daily-red-agent',
      experiment: `battles ${note.version} · ${policy}`,
      description: note.change,
      metadata: { kind: 'battles', batch: tag, version: note.version, policy, change: note.change },
      tags: ['battles', note.version, policy],
      gitMetadataSettings: { collect: 'some', fields: ['commit', 'branch', 'dirty'] },
    });
    for (const r of rows.filter((x) => x.policy === policy && x.redKnockedOut != null)) {
      const stats = r.decisionLog ? battleStats(r.decisionLog) : {};
      experiment.log({
        input: { team: r.seed, members: r.team, round: r.round },
        output: { result: r.result, red_knocked_out: r.redKnockedOut, red_left: r.redLeft, turns: r.turns, ...stats },
        scores: { red_knocked_out: r.redKnockedOut / 6, won: r.result === 'WON' ? 1 : 0 },
        metrics: { ...battleMetrics(r), ...Object.fromEntries(['outlook_first', 'outlook_mid', 'outlook_mean', 'too_early_first', 'too_early_mean', 'first_called_turn'].filter((k) => stats[k] != null).map((k) => [k, stats[k]])) },
        metadata: {
          batch: tag, version: note.version, policy, team: r.seed, round: r.round,
          input_tokens: r.inputTokens, requests: r.requests, median_latency_ms: r.medianMs,
          lead: stats.lead, switch_rate: stats.switch_rate, protect_rate: stats.protect_rate, hyper_beam_uses: stats.hyper_beam_uses,
        },
      });
    }
    const summary = await experiment.summarize();
    urls.push(`${policy}: ${summary.experimentUrl}`);
  }
  return urls;
}

// Run directly: backfill the batches named on the command line (default: all).
if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.loadEnvFile(new URL('./.env', import.meta.url)); } catch { /* use the environment */ }
  const tags = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(BATCH_NOTES);
  for (const tag of tags) {
    const rows = JSON.parse(readFileSync(new URL(`./output/${tag}-summary.json`, import.meta.url), 'utf8'));
    const urls = await logBattleBatch(tag, rows);
    console.log(`${BATCH_NOTES[tag]?.version ?? tag} (${rows.length} battles): ${urls.join('  ')}`);
  }
}
