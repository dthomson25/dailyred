// Turns a battle situation into Jev questions and Jev's answers into an action.
//
// Code does everything that is arithmetic: damage ranges, knock-out odds,
// speed order, legality. Jev gets those results as plain language and makes
// the judgment a player makes: which of the legal actions gives the best
// chance of winning the whole battle.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TypeSafeClient } from '@typesafe-ai/sdk';
import OpenAI from 'openai';
import {
  MOVE_DATA, SPECIES, MOVES, ITEMS, ABILITIES, SPECIES_DATA, TYPES, effectText, effectivenessWord, typeName, itemName,
  abilityName, speciesName, pretty, effectiveness, genderOf, RED_PARTY,
} from './data.mjs';
import { predictRedMove, simulateOneOnOne, isTwoTurn, predictRedSwitchIn } from './redai.mjs';
import { estimateDamage, effectiveSpeed, resolveMove, STAGE } from './damage.mjs';

// --- Describing Pokémon -----------------------------------------------------------------
// Percent of a total; anything above zero shows as at least 1% (1 HP of 272 is not "0%").
const pct = (n, of) => (n > 0 ? Math.max(1, Math.round((100 * n) / of)) : 0);

export function statusText(status1) {
  // The sleep counter drops each turn the Pokémon tries to move; it wakes and
  // acts when it reaches 0, so it loses (counter - 1) more turns.
  if (status1 & 0x7) {
    const lost = (status1 & 0x7) - 1;
    return lost ? `asleep (can't act for about ${lost} more turn${lost === 1 ? '' : 's'})` : 'asleep (wakes up and acts this turn)';
  }
  if (status1 & 0x80) return 'badly poisoned';
  if (status1 & 0x8) return 'poisoned';
  if (status1 & 0x10) return 'burned';
  if (status1 & 0x20) return 'frozen';
  if (status1 & 0x40) return 'paralyzed';
  return 'healthy';
}

const STAGE_NAMES = { [STAGE.ATK]: 'Attack', [STAGE.DEF]: 'Defense', [STAGE.SPEED]: 'Speed', [STAGE.SPATK]: 'Sp. Atk', [STAGE.SPDEF]: 'Sp. Def', [STAGE.ACC]: 'accuracy', [STAGE.EVASION]: 'evasion' };
function stageText(stages) {
  const out = [];
  for (const [i, name] of Object.entries(STAGE_NAMES)) {
    const d = stages[i] - 6;
    if (d) out.push(`${name} ${d > 0 ? '+' : ''}${d}`);
  }
  return out.length ? out.join(', ') : 'none';
}

// When a Pokémon under Perish Song faints, in words. count 0 = this turn.
const perishWhen = (count) => (count === 0 ? 'at the end of this turn' : count === 1 ? 'at the end of next turn' : `in ${count + 1} turns`);

const typesText = (types) => [...new Set(types)].map(typeName).join('/');

function describeMon(mon, { side }) {
  const out = {
    pokemon: mon.speciesName,
    types: typesText(mon.types),
    hp: `${pct(mon.hp, mon.maxHp)}% (${mon.hp}/${mon.maxHp})`,
    status: statusText(mon.status1),
    stat_changes: stageText(mon.stages),
    item: itemName(mon.item),
    ability: abilityName(mon.ability),
  };
  const extra = [];
  if (mon.status2 & 0x7) extra.push('confused');
  if (mon.status2 & 0x1000000) extra.push(`behind a substitute`);
  if (mon.status2 & 0x400000) extra.push('must recharge this turn');
  if (mon.status2 & 0xE000) extra.push('trapped by a binding move');
  if (mon.status2 & 0x4000000) extra.push('cannot switch out');
  if (mon.status2 & 0xF0000) extra.push('infatuated');
  if (mon.leechSeeded) extra.push('leech seeded');
  if (mon.perishCount != null) extra.push(`Perish Song: faints ${perishWhen(mon.perishCount)} unless it switches out`);
  if (mon.tauntTurns) extra.push('taunted');
  if (extra.length) out.conditions = extra.join(', ');
  if (side === 'foe') out.moves = mon.moves.map((id, i) => (id ? `${MOVE_DATA.get(id).name} (${mon.pp[i]} PP left)` : null)).filter(Boolean).join(', ');
  return out;
}

// --- Damage in words ------------------------------------------------------------------------
// One attack's result against a defender, e.g. "62-73% of its current HP;
// guaranteed knockout".
function damageWords(est, defender) {
  if (!est) return null;
  if (est.effectiveness === 0) return 'no effect (the target is immune)';
  if (est.unknown) return `damage varies (${effectivenessWord(est.effectiveness)})`;
  const eff = effectivenessWord(est.effectiveness);
  if (est.min >= defender.hp) return `more than its remaining HP (${eff}); guaranteed to knock it out`;
  const lo = pct(est.min, defender.hp), hi = Math.min(100, pct(est.max, defender.hp));
  const range = lo === hi ? `${lo}%` : `${lo}-${hi}%`;
  if (est.max >= defender.hp) {
    return `${range} of its remaining HP (${eff}); may knock it out (about ${Math.round(100 * koChance(est, defender.hp))}% chance)`;
  }
  return `${range} of its remaining HP (${eff}); does not knock it out, about ${Math.ceil(defender.hp / Math.max(1, (est.min + est.max) / 2))} hits needed`;
}

const koChance = (est, hp) => (!est || est.effectiveness === 0 || est.unknown ? 0
  : est.min >= hp ? 1 : est.max >= hp ? (est.max - hp + 1) / (est.max - est.min + 1) : 0);

// Which side moves first with these moves.
function speedOrder(you, foe, yourPriority, foePriority, weather) {
  if (yourPriority !== foePriority) return yourPriority > foePriority ? 'you' : 'foe';
  const a = effectiveSpeed(you, weather), b = effectiveSpeed(foe, weather);
  return a > b ? 'you' : a < b ? 'foe' : 'tie';
}

// The foe's attacks against one of our Pokémon, strongest first.
function threats(foe, target, field) {
  return foe.moves.filter(Boolean).map((id) => {
    const move = resolveMove(id, foe, field.weather);
    const est = estimateDamage(id, foe, target, { weather: field.weather, defenderScreens: field.playerSide });
    return { id, move, est, avg: est && !est.unknown ? (est.min + est.max) / 2 : 0 };
  }).sort((a, b) => b.avg - a.avg);
}

// RED's likely moves against `target`, from FireRed's AI (redai.mjs), each
// with its damage and the chance the AI picks it.
function redMoves(foe, target, field) {
  const byId = new Map(threats(foe, target, field).map((t) => [t.id, t]));
  return predictRedMove(foe, target, field).map((p) => ({ ...byId.get(p.id), p: p.p }));
}
// The chance RED knocks `target` out this turn over its likely moves (accuracy
// included), and the move most responsible for it.
function redKo(foe, target, field) {
  let total = 0, top = null, topShare = 0;
  for (const m of redMoves(foe, target, field)) {
    if (!m.avg) continue;
    const share = m.p * koChance(m.est, target.hp) * ((m.move.accuracy || 100) / 100);
    total += share;
    if (share > topShare) { topShare = share; top = m; }
  }
  return { ko: total, move: top };
}
function threatWords(foe, target, field) {
  const [top] = threats(foe, target, field);
  if (!top || !top.avg) return `${foe.speciesName} has no damaging move that hurts ${target.speciesName}`;
  return `${foe.speciesName}'s strongest attack on ${target.speciesName} is ${top.move.name} (${typeName(top.move.type)}): ${damageWords(top.est, target)}`;
}

// Our best attack against the foe, for comparing bench Pokémon.
function bestAttack(mon, foe, field) {
  let best = null;
  for (const id of mon.moves.filter(Boolean)) {
    const est = estimateDamage(id, mon, foe, { weather: field.weather, defenderScreens: field.foeSide });
    if (!est || est.unknown) continue;
    const avg = (est.min + est.max) / 2;
    if (!best || avg > best.avg) best = { id, est, avg, name: MOVE_DATA.get(id).name };
  }
  return best;
}

// Optional policy (play.mjs --filter-flagged): drop options marked as wasted,
// failing or fainting before attacking whenever an unmarked option exists.
let filterFlagged = false;
export function setFilterFlagged(on) { filterFlagged = !!on; }
const isFlaggedOption = (o) => o.fails || /Danger: |Wasted: |Will fail: |Faints before attacking: /.test(o.text);
function applyFilter(options) {
  if (!filterFlagged) return options;
  const safe = options.filter((o) => !isFlaggedOption(o));
  return safe.length ? safe : options;
}

// --- Option layout -------------------------------------------------------------------------------
// "plain": the action first, then its facts. "consequence": what will happen
// first (wasted, fails, knocks out, no benefit...), then the details. Set by
// play.mjs --layout.
let layout = 'plain';
export function setLayout(name) { layout = name; }
// Sentences that state a consequence; in the consequence layout they move to the front.
const CONSEQUENCE = /^(Plan|Lead cost|Lead exchange|Next|Danger|Warning|Risk|Risky|Benefit|No benefit|Little benefit|Sacrifice|Stalling|Faints before attacking|Note|Recharge cost|Overkill|Trade|Exchange):/;
// A knockout risk is called certain ("Wasted", "Faints before attacking",
// removed by the filter) from 70%; from 30% it's labeled "Risky" and kept.
const LIKELY = 0.7;
const pctOf = (x) => Math.round(x * 100);

// The one-on-one from here, played out in code with expected damage: both
// sides use their best attack (accuracy included) every turn in speed order.
// startHp lets a switch-in start after taking the hit on the way in.
// Our attacks for a long exchange, best first: no self-destructing moves, and
// a recharge or charge-turn move counts as half its damage per turn. Moves
// with no PP left are skipped; the simulation moves down the list as PP runs out.
function steadyAttacks(mon, foe, field) {
  const list = [];
  mon.moves.forEach((id, i) => {
    if (!id || (mon.pp && mon.pp[i] <= 0)) return;
    const move = MOVE_DATA.get(id);
    if (move.effect === 'EXPLOSION') return;
    const est = estimateDamage(id, mon, foe, { weather: field.weather, defenderScreens: field.foeSide });
    if (!est || est.unknown || !est.max) return;
    const avg = ((est.min + est.max) / 2) * ((move.accuracy || 100) / 100) * (move.effect === 'RECHARGE' || isTwoTurn(move, field.weather) ? 0.5 : 1);
    list.push({ id, avg });
  });
  return list.sort((a, b) => b.avg - a.avg);
}
// The one-on-one from here, played out 200 times in code (redai.mjs): RED
// picks its moves with its own AI, including sleep, Leech Seed and healing.
function exchange(mon, foe, field, startHp = mon.hp, setup = []) {
  // With setup moves, rank the attacks as they will be after the boosts.
  const boostOf = setup.map((id) => SELF_BOOSTS[MOVE_DATA.get(id).effect]).filter(Boolean).reduce((a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v;
    return out;
  }, {});
  const ours = steadyAttacks(Object.keys(boostOf).length ? withStages(mon, boostOf) : mon, foe, field);
  const hasThreat = foe.moves.some((id) => id && MOVE_DATA.get(id));
  if (!ours.length && !hasThreat) return null;
  const x = simulateOneOnOne(mon, foe, field, { ourMoveIds: ours.map((o) => o.id), setup, startHp: Math.max(1, startHp) });
  const move = ours.length ? MOVE_DATA.get(ours[0].id) : null;
  const slot = move ? mon.moves.indexOf(ours[0].id) : -1;
  return { ...x, moveName: move?.name, recharge: move?.effect === 'RECHARGE', pp: slot >= 0 ? mon.pp?.[slot] : null };
}
// A setup plan against just attacking, both played out with RED's AI:
// "Toxic first, then Slash: wins about 70% of the time (about 6 turns), against 20% attacking right away."
function planText(you, foe, field, move) {
  const plan = exchange(you, foe, field, you.hp, [move.id ?? MOVES.byName.get(move.name.toUpperCase().replace(/ /g, '_'))]);
  const plain = exchange(you, foe, field, you.hp);
  if (!plan || !plain) return '';
  const turns = (x) => (x.winTurns ? ` (about ${Math.max(1, Math.round(x.winTurns))} turns)` : '');
  return `Plan: ${move.name} first, then ${plan.moveName ?? 'attacking'}: ${you.speciesName} wins this one-on-one about ${pctOf(plan.pWin)}% of the time${turns(plan)}, against ${pctOf(plain.pWin)}% attacking right away${plain.moveName ? ` with ${plain.moveName}` : ''}${turns(plain)}.`;
}

// "with Hyper Beam" plus what a recharge move costs after the knockout.
const usingText = (x, foe) => (x.moveName ? ` using ${x.moveName}${x.recharge ? `, then losing a turn to recharge while RED's next Pokémon gets a free attack` : ''}` : '');
function exchangeText(mon, foe, field, startHp) {
  const x = exchange(mon, foe, field, startHp);
  if (!x) return '';
  const turns = (n) => `${Math.max(1, Math.round(n))} turn${Math.round(n) <= 1 ? '' : 's'}`;
  const heal = foe.moves.map((id) => id && MOVE_DATA.get(id)).find((m) => m && HEALING_EFFECTS.has(m.effect));
  const healed = heal && x.heals >= 0.3 ? `; ${foe.speciesName} often heals with ${heal.name} along the way` : '';
  if (x.pWin >= 0.5) return `Exchange: ${mon.speciesName} wins this one-on-one about ${pctOf(x.pWin)}% of the time${usingText(x, foe)} (usually in about ${turns(x.winTurns)}, with about ${Math.max(1, pctOf(x.winLeft))}% HP left${healed}).`;
  if (x.pLose >= 0.5) {
    if (x.loseDealt < 0.01 && !healed) return x.pLose < 0.9 ? `Exchange: ${foe.speciesName} wins this one-on-one about ${pctOf(x.pLose)}% of the time, usually before ${mon.speciesName} can do damage.` : '';
    return `Exchange: ${foe.speciesName} wins this one-on-one about ${pctOf(x.pLose)}% of the time; ${mon.speciesName} takes off about ${Math.min(99, pctOf(x.loseDealt))}% of its HP first${healed}.`;
  }
  return `Exchange: neither side usually wins within 15 turns (${mon.speciesName} wins ${pctOf(x.pWin)}%, ${foe.speciesName} ${pctOf(x.pLose)}%${healed}).`;
}

// RED's next Pokémon if `foe` faints now, picked by RED's AI against `mon`
// (redai.mjs predictRedSwitchIn), and how `mon` would fare against it. Used
// for leads, where the lead decides who RED brings in next. (Not on turn
// options: on a single knockout move it read as a downside of the knockout,
// though RED's replacement comes whatever the player does.)
function nextFoeText(mon, foe, foeTeam, field, hp = mon.hp, verb = 'faints', others = []) {
  if (!foeTeam?.length) return '';
  const isFoe = (m) => m === foe || (m.personality != null ? m.personality === foe.personality : m.speciesName === foe.speciesName);
  const team = foeTeam.map((m) => (isFoe(m) ? { ...foe, hp: 0 } : m));
  const next = predictRedSwitchIn(team, { ...mon, hp }, field, foe);
  if (!next) return '';
  const x = exchange({ ...mon, hp }, next, field, hp);
  const how = !x ? '' : x.pWin >= 0.5 ? `; ${mon.speciesName} then beats it about ${pctOf(x.pWin)}% of the time`
    : `; ${next.speciesName} then beats ${mon.speciesName} about ${pctOf(x.pLose)}% of the time`;
  // When it would beat `mon`: your best answer to it among the rest of the team.
  const alive = others.filter((m) => m.hp > 0 && m !== mon);
  let backup = '';
  if (alive.length && !(x?.pWin >= 0.5)) {
    const best = alive.map((m) => ({ m, p: exchange(m, next, field)?.pWin ?? 0 })).sort((a, b) => b.p - a.p)[0];
    backup = best.p >= 0.5 ? `; your best answer to ${next.speciesName} is ${best.m.speciesName} (wins about ${pctOf(best.p)}%)`
      : `; none of your other Pokémon wins a one-on-one against ${next.speciesName} (best: ${best.m.speciesName}, about ${pctOf(best.p)}%)`;
  }
  return `Next: if ${foe.speciesName} ${verb}, RED's AI will most likely send in ${next.speciesName} (it picks a Pokémon that counters ${mon.speciesName})${how}${backup}.`;
}

// What using a damaging move costs beyond its turn.
function moveDownsides(move, pp) {
  const d = [];
  if (move.effect === 'RECHARGE') d.push('a recharge turn');
  if (move.accuracy && move.accuracy < 100) d.push(`${move.accuracy}% accuracy`);
  if (move.effect === 'RECOIL' || move.effect === 'DOUBLE_EDGE') d.push('recoil damage');
  if (move.effect === 'OVERHEAT' || move.effect === 'SUPERPOWER') d.push('lowered stats');
  if (move.effect === 'EXPLOSION') d.push('fainting');
  if (pp <= 5) d.push(`using one of its last ${pp} PP`);
  return d;
}
function arrange(parts, headline = []) {
  const kept = parts.filter(Boolean);
  if (layout !== 'consequence') return kept.join(' ');
  const first = [...headline, ...kept.filter((p) => CONSEQUENCE.test(p))];
  return [...first, ...kept.filter((p) => !CONSEQUENCE.test(p))].join(' ');
}

// --- Legal actions ----------------------------------------------------------------------------
// Gen 3 type immunities to status. Electric types can still be paralyzed
// (that came in Gen 6); Thunder Wave misses Ground types through the type chart.
const STATUS_IMMUNE = {
  POISON: ['POISON', 'STEEL'], TOXIC: ['POISON', 'STEEL'], WILL_O_WISP: ['FIRE'],
};
const STATUS_EFFECTS = new Set(['SLEEP', 'POISON', 'TOXIC', 'PARALYZE', 'WILL_O_WISP', 'YAWN']);

// Reasons a move would do nothing, worked out in code.
function failureReason(id, you, foe) {
  const move = MOVE_DATA.get(id);
  if (STATUS_EFFECTS.has(move.effect)) {
    if (foe.status1 & 0xFF) return `${foe.speciesName} already has a status condition, so it will fail`;
    if (foe.status2 & 0x1000000) return `${foe.speciesName} is behind a substitute, so it will fail`;
    const immune = (STATUS_IMMUNE[move.effect] ?? []).map((t) => TYPES.byName.get(t));
    if (foe.types.some((t) => immune.includes(t))) return `${foe.speciesName}'s type is immune, so it will fail`;
    if (move.effect === 'PARALYZE' && move.type === TYPES.byName.get('ELECTRIC') && effectiveness(move.type, foe.types) === 0) return `${foe.speciesName} is a Ground type, so it will fail`;
    if (move.effect === 'PARALYZE' && foe.ability === ABILITIES.byName.get('LIMBER')) return `${foe.speciesName}'s Limber prevents paralysis`;
    if (move.effect === 'SLEEP' && [ABILITIES.byName.get('INSOMNIA'), ABILITIES.byName.get('VITAL_SPIRIT')].includes(foe.ability)) return `${foe.speciesName}'s ability prevents sleep`;
  }
  if (move.effect === 'PERISH_SONG' && foe.perishCount != null) return `${foe.speciesName} is already under Perish Song`;
  if (move.effect === 'ATTRACT' && you.personality != null && foe.personality != null) {
    const a = genderOf(you.species, you.personality), b = genderOf(foe.species, foe.personality);
    if (a === 'genderless' || b === 'genderless') return 'a genderless Pokémon cannot be infatuated or infatuate, so it will fail';
    if (a === b) return `${foe.speciesName} is the same gender (${b}), so it will fail`;
  }
  if (move.effect === 'CONFUSE' && (foe.status2 & 0x7)) return `${foe.speciesName} is already confused`;
  if (move.effect === 'LEECH_SEED' && (foe.leechSeeded || foe.types.includes(TYPES.byName.get('GRASS')))) return 'it will fail (already seeded or a Grass type)';
  if (move.effect === 'DREAM_EATER' && !(foe.status1 & 0x7)) return 'the target is not asleep, so it will fail';
  if (move.effect === 'SUBSTITUTE' && (you.status2 & 0x1000000)) return 'you already have a substitute';
  if (move.effect === 'SUBSTITUTE' && you.hp <= you.maxHp / 4) return 'not enough HP to make a substitute';
  if (['RESTORE_HP', 'SOFTBOILED', 'MORNING_SUN', 'MOONLIGHT', 'SYNTHESIS', 'REST'].includes(move.effect) && you.hp === you.maxHp) return 'you are at full HP, so it will fail';
  if ((move.effect === 'PROTECT' || move.effect === 'ENDURE') && you.protectUses) {
    return `used on the previous turn, so it only has a ${Math.round(100 / 2 ** you.protectUses)}% chance to work this time`;
  }
  if (move.effect === 'FAKE_OUT') return 'only works on the first turn after switching in (likely to fail)';
  if (move.effect === 'SNORE' || move.effect === 'SLEEP_TALK') { if (!(you.status1 & 0x7)) return 'only works while you are asleep'; }
  return null;
}

// Whether the active Pokémon has any move with PP left that damages the foe.
function canStillDamage(you, foe, field) {
  return usableMoveSlots(you).some((i) => {
    const est = estimateDamage(you.moves[i], you, foe, { weather: field.weather, defenderScreens: field.foeSide });
    return est && (est.max > 0 || est.unknown);
  });
}

// Abilities that punish contact moves (AbilityBattleEffects in battle_util.c).
const CONTACT_ABILITIES = {
  STATIC: { chance: 33, what: 'paralyze you' },                              // Electric types can be paralyzed in Gen 3
  FLAME_BODY: { chance: 33, what: 'burn you', immune: ['FIRE'] },
  POISON_POINT: { chance: 33, what: 'poison you', immune: ['POISON', 'STEEL'] },
  EFFECT_SPORE: { chance: 10, what: 'poison, paralyze or put you to sleep' },
};
function contactWarning(move, attacker, defender) {
  if (!move.contact || (attacker.status1 & 0xFF)) return null;
  const name = ABILITIES.byId.get(defender.ability);
  const rule = CONTACT_ABILITIES[name];
  if (!rule) return null;
  if (rule.immune?.some((t) => attacker.types.includes(TYPES.byName.get(t)))) return null;
  return `${move.name} makes contact: ${defender.speciesName}'s ${abilityName(defender.ability)} has a ${rule.chance}% chance to ${rule.what}.`;
}

// Turns to knock out the foe from its current HP: attacking every turn with
// the best attack, against Toxic first and then attacking (bad poison deals
// 1/16, 2/16, 3/16... of max HP at the end of each turn). Leftovers heals
// 1/16 a turn.
function turnsToKo(hpShare, hitShare, { toxicFirst = false, setup = false, leftovers = false } = {}) {
  let hp = hpShare, k = 0;
  for (let t = 1; t <= 40; t++) {
    if (!(toxicFirst || setup) || t > 1) hp -= hitShare;
    if (toxicFirst) hp -= ++k / 16;
    if (hp <= 0) return t;
    if (leftovers) hp = Math.min(1, hp + 1 / 16);
  }
  return Infinity;
}

const SELF_BOOSTS = {
  ATTACK_UP: { [STAGE.ATK]: 1 }, ATTACK_UP_2: { [STAGE.ATK]: 2 },
  SPECIAL_ATTACK_UP: { [STAGE.SPATK]: 1 }, SPECIAL_ATTACK_UP_2: { [STAGE.SPATK]: 2 },
  DEFENSE_UP: { [STAGE.DEF]: 1 }, DEFENSE_UP_2: { [STAGE.DEF]: 2 }, SPECIAL_DEFENSE_UP_2: { [STAGE.SPDEF]: 2 },
  CALM_MIND: { [STAGE.SPATK]: 1, [STAGE.SPDEF]: 1 }, BULK_UP: { [STAGE.ATK]: 1, [STAGE.DEF]: 1 },
  DRAGON_DANCE: { [STAGE.ATK]: 1, [STAGE.SPEED]: 1 }, COSMIC_POWER: { [STAGE.DEF]: 1, [STAGE.SPDEF]: 1 },
  SPEED_UP_2: { [STAGE.SPEED]: 2 },
};
const FOE_SPEED_DROPS = { SPEED_DOWN: 1, SPEED_DOWN_2: 2 };
const withStages = (mon, deltas) => {
  const stages = [...mon.stages];
  for (const [i, d] of Object.entries(deltas)) stages[i] = Math.max(0, Math.min(12, stages[i] + d));
  return { ...mon, stages };
};

const HEALING_EFFECTS = new Set(['REST', 'RESTORE_HP', 'SOFTBOILED', 'MORNING_SUN', 'MOONLIGHT', 'SYNTHESIS', 'WISH']);

// Move slots the game will let us pick this turn.
function usableMoveSlots(you) {
  const slots = [];
  for (let i = 0; i < 4; i++) {
    const id = you.moves[i];
    if (!id || you.pp[i] === 0) continue;
    if (id === you.disabledMove) continue;
    if (you.tauntTurns && !MOVE_DATA.get(id).power) continue;
    if (you.choicedMove && you.choicedMove !== 0xFFFF && you.item === ITEMS.byName.get('CHOICE_BAND') && you.choicedMove !== id && you.moves.includes(you.choicedMove)) continue;
    if ((you.status2 & 0x80000000) && id === you.lastMove) continue;
    slots.push(i);
  }
  return slots;
}

// Every legal action this turn, each with a plain-language description.
// `history` is the list of earlier turns (see play.mjs). Switching straight
// back to a Pokémon switched out in the last two turns isn't offered: that
// only hands the foe free attacks.
export function buildTurnOptions(battle, excluded = new Set(), history = []) {
  return applyFilter(buildAllTurnOptions(battle, excluded, history));
}
function buildAllTurnOptions(battle, excluded = new Set(), history = []) {
  const { you, foe, bench, field } = battle;
  const options = [];
  // Chance RED knocks out the active Pokémon this turn, over the moves its AI
  // is likely to pick (accuracy included), and the move that would do it.
  const red = redKo(foe, you, field);
  const foeFastest = red.move ?? threats(foe, you, field)[0];
  const foeKo = red.ko;
  const noDamage = !canStillDamage(you, foe, field);
  // Stalling only pays when the foe loses something by waiting.
  const stallPays = foe.perishCount != null || (foe.status1 & 0x98) || foe.leechSeeded;
  const recentSwitches = history.filter((h) => h.turn >= battle.turn - 3 && h.switchedOut).length;
  // A filler Pokémon may faint: the next one then comes in without taking a hit.
  const youFiller = isFiller(battle.roles, you);
  const freeSendIn = bench.find((m) => battle.roles?.get(m.personality)?.answerTo.includes(foe.speciesName));
  const sacrificeText = `${you.speciesName} is filler, so it is fine if it faints here: you then send in ${freeSendIn ? `${freeSendIn.speciesName} (the planned answer to ${foe.speciesName})` : 'your best Pokémon for this matchup'} for free, without it taking a hit.`;
  for (const i of usableMoveSlots(you)) {
    const key = `move_${i + 1}`;
    if (excluded.has(key)) continue;
    const id = you.moves[i];
    const move = resolveMove(id, you, field.weather);
    if ((move.effect === 'PROTECT' || move.effect === 'ENDURE') && you.protectUses >= 2 && !stallPays) continue;
    const est = estimateDamage(id, you, foe, { weather: field.weather, defenderScreens: field.foeSide });
    const order = speedOrder(you, foe, move.priority, foeFastest?.move.priority ?? 0, field.weather);
    const parts = [
      `Use ${move.name} (${typeName(move.type)}, ${est?.fixed ? 'fixed damage' : move.power ? `${move.power} power` : 'status move'}, ${move.accuracy ? `${move.accuracy}% accuracy` : 'never misses'}, ${you.pp[i]} PP left).`,
    ];
    if (est) {
      const words = damageWords(est, foe);
      parts.push(`Expected damage to ${foe.speciesName}: ${move.accuracy && move.accuracy < 100 ? words.replace('guaranteed to knock it out', 'knocks it out if it hits') : words}.`);
    }
    parts.push(`Effect: ${effectText(move)}${move.chance ? ` (${move.chance}% chance)` : ''}.`);
    if ((move.effect === 'PROTECT' || move.effect === 'ENDURE') && foe.perishCount != null) {
      parts.push(`Stalling: ${foe.speciesName} faints from Perish Song ${perishWhen(foe.perishCount)} if it stays in, so surviving this turn brings that closer. Each use in a row halves its chance to work.`);
    } else if ((move.effect === 'PROTECT' || move.effect === 'ENDURE') && noDamage) {
      parts.push(`It only delays: ${you.speciesName} has no damaging moves left, so waiting does not help it knock ${foe.speciesName} out. Each use in a row halves its chance to work.`);
    } else if (move.effect === 'PROTECT' || move.effect === 'ENDURE') {
      parts.push(`It does no damage and only delays: it helps only if waiting a turn helps (for example RED using up PP, or poison or Leech Seed damage on RED). Each use in a row halves its chance to work.`);
    }
    if (move.effect === 'TOXIC' && !failureReason(id, you, foe)) {
      const best = bestAttack(you, foe, field);
      const lefties = foe.item === ITEMS.byName.get('LEFTOVERS');
      const hpShare = foe.hp / foe.maxHp;
      const hit = best ? best.avg / foe.maxHp : 0;
      const withToxic = turnsToKo(hpShare, hit, { toxicFirst: true, leftovers: lefties });
      const without = hit ? turnsToKo(hpShare, hit, { leftovers: lefties }) : Infinity;
      const [theirs] = threats(foe, you, field);
      const survive = theirs?.avg ? Math.ceil(you.hp / theirs.avg) - 1 : Infinity;
      const words = (n) => (Number.isFinite(n) ? `about ${n} turn${n === 1 ? '' : 's'}` : 'never');
      parts.push(planText(you, foe, field, { ...move, id }) || `Toxic first${best ? `, then ${best.name}` : ''}: knocks ${foe.speciesName} out in ${words(withToxic)}, against ${words(without)} ${best ? `with ${best.name} alone` : 'without it'}${lefties ? ` (counting its Leftovers)` : ''}. ${you.speciesName} survives ${Number.isFinite(survive) ? `about ${survive} of its attacks` : 'its attacks indefinitely'}.`);
      const heals = foe.moves.filter((m) => m && HEALING_EFFECTS.has(MOVE_DATA.get(m).effect)).map((m) => MOVE_DATA.get(m).name);
      if (heals.includes('Rest')) parts.push(`${foe.speciesName} knows Rest, which cures poison.`);
      else if (heals.length) parts.push(`${foe.speciesName} can heal with ${heals.join(' and ')}, which undoes attack damage but not the growing poison.`);
    }
    const boost = SELF_BOOSTS[move.effect];
    if (boost && (move.effect !== 'CURSE')) {
      const boosted = withStages(you, boost);
      const before = bestAttack(you, foe, field), after = bestAttack(boosted, foe, field);
      if (before && after && after.avg > before.avg) {
        const lefties = foe.item === ITEMS.byName.get('LEFTOVERS');
        const hpShare = foe.hp / foe.maxHp;
        const first = turnsToKo(hpShare, after.avg / foe.maxHp, { setup: true, leftovers: lefties });
        const alone = turnsToKo(hpShare, before.avg / foe.maxHp, { leftovers: lefties });
        const [theirs] = threats(foe, boosted, field);
        const survive = theirs?.avg ? Math.ceil(you.hp / theirs.avg) - 1 : Infinity;
        const words = (n) => (Number.isFinite(n) ? `about ${n} turn${n === 1 ? '' : 's'}` : 'never');
        parts.push(planText(you, foe, field, { ...move, id }) || `${move.name} first, then ${after.name}: knocks ${foe.speciesName} out in ${words(first)}, against ${words(alone)} with ${before.name} alone. ${you.speciesName} survives ${Number.isFinite(survive) ? `about ${survive} of its attacks` : 'its attacks indefinitely'} after the boost.`);
      }
    }
    // Speed changes: say who would move first afterwards.
    const drop = FOE_SPEED_DROPS[move.effect];
    const paralyzes = move.effect === 'PARALYZE' && !failureReason(id, you, foe);
    const selfSpeed = boost?.[STAGE.SPEED];
    if ((drop || paralyzes || selfSpeed) && speedOrder(you, foe, 0, 0, field.weather) !== 'you') {
      const you2 = selfSpeed ? withStages(you, { [STAGE.SPEED]: selfSpeed }) : you;
      const foe2 = drop ? withStages(foe, { [STAGE.SPEED]: -drop }) : paralyzes ? { ...foe, status1: foe.status1 | 0x40 } : foe;
      const a = effectiveSpeed(you2, field.weather), b = effectiveSpeed(foe2, field.weather);
      parts.push(a > b ? `Afterwards you would move before ${foe.speciesName} (speed ${a} vs ${b}).` : `${foe.speciesName} would still move first afterwards (speed ${b} vs ${a}).`);
    }
    if (layout !== 'consequence' && est && move.accuracy && move.accuracy < 100) {
      const ko = koChance(est, foe.hp);
      if (ko > 0) parts.push(`Counting its ${move.accuracy}% accuracy, the chance to knock ${foe.speciesName} out this turn is about ${Math.round(ko * move.accuracy)}%.`);
    }
    if (move.effect === 'PERISH_SONG' && foe.perishCount == null) {
      parts.push(`After it, both Pokémon on the field faint after 3 more turns unless they switch out, so the plan becomes stalling: Protect, or switching to a Pokémon that can take hits. RED's AI switches its Pokémon out on the last turn unless it is trapped, so it forces a switch rather than a knockout unless ${foe.speciesName} cannot leave.`);
    }
    if (you.perishCount === 0 && move.effect !== 'PROTECT') {
      parts.push(`Warning: ${you.speciesName} faints from Perish Song at the end of this turn whatever happens, unless it switches out.`);
    }
    if (est && est.effectiveness && order === 'you') parts.push(`You move before ${foe.speciesName} this turn.`);
    // Moving first but fainting to the reply this same turn: the move lands, then
    // you're knocked out. Not a flag (trading a hit is often right); just said plainly.
    const isProtect = move.effect === 'PROTECT' || move.effect === 'ENDURE';
    if (order !== 'foe' && foeKo >= 0.3 && !isProtect && koChance(est, foe.hp) < 0.99) {
      parts.push(`Trade: ${move.name} ${order === 'tie' ? 'may land first' : 'lands first'}, then ${foe.speciesName}'s ${foeFastest.move.name} knocks ${you.speciesName} out (about ${Math.round(foeKo * 100)}% chance) this same turn.`);
    }
    if (order === 'foe' && foeKo >= LIKELY) {
      parts.push(`Danger: ${foe.speciesName} moves first and its ${foeFastest.move.name} knocks you out (about ${pctOf(foeKo)}% chance) before this move happens, so this move would most likely never be used.`);
      if (youFiller) parts.push(sacrificeText);
    } else if (order === 'foe' && foeKo >= 0.3) {
      parts.push(`Risk: ${foe.speciesName} moves first and its ${foeFastest.move.name} may knock you out (about ${pctOf(foeKo)}% chance) before this move happens.`);
      if (youFiller) parts.push(sacrificeText);
    } else if (youFiller && foeKo >= 0.3) {
      parts.push(`${foe.speciesName} may knock ${you.speciesName} out after this move. ${sacrificeText}`);
    } else if (order === 'foe') parts.push(`${foe.speciesName} moves first this turn.`);
    if (order === 'tie') parts.push('Speed tie: either side may move first.');
    if (move.effect === 'RECHARGE' && est && est.effectiveness) {
      // Gen 3: the recharge turn happens even when this move knocks the target out.
      if (koChance(est, foe.hp) >= 0.99) {
        parts.push(`Recharge cost: ${move.accuracy && move.accuracy < 100 ? 'if it hits, ' : ''}${foe.speciesName} faints, but you can't act next turn, so RED's next Pokémon gets a free attack on ${you.speciesName}.`);
      } else if (foeFastest?.est && !foeFastest.est.unknown) {
        const lo = Math.round((100 * 2 * foeFastest.est.min) / you.hp), hi = Math.round((100 * 2 * foeFastest.est.max) / you.hp);
        const verdict = 2 * foeFastest.est.min >= you.hp ? 'knocks you out' : 2 * foeFastest.est.max >= you.hp ? 'may knock you out' : 'does not knock you out';
        const total = lo >= 100 ? '100% or more' : hi > 100 ? `${lo}% to over 100%` : `${lo}-${hi}%`;
        parts.push(`Recharge cost: you can't act next turn, so ${foe.speciesName} attacks twice before you move again: about ${total} of your HP in total (${verdict}).`);
      }
    }
    const contact = est && est.effectiveness ? contactWarning(move, you, foe) : null;
    if (contact) parts.push(contact);
    const why = failureReason(id, you, foe);
    if (why) parts.push(`Warning: ${why}.`);
    const headline = [];
    let body = parts;
    if (layout === 'consequence') {
      // The consequence becomes the headline; its longer sentence isn't repeated.
      const ko = koChance(est, foe.hp) * ((move.accuracy || 100) / 100);
      const risk = order === 'foe' && foeKo >= 0.3;
      if (why && /^used on the previous turn/.test(why)) headline.push(`Unreliable: ${why}.`);
      else if (why) headline.push(`Will fail: ${why}.`);
      else if (risk && foeKo >= LIKELY) headline.push(`Wasted: ${foe.speciesName} moves first and its ${foeFastest.move.name} knocks you out (about ${pctOf(foeKo)}% chance) before this move happens.`);
      else {
        if (risk) headline.push(`Risky: ${foe.speciesName} moves first and may knock you out (about ${pctOf(foeKo)}% chance) before this move happens.`);
        if (ko >= 0.99) headline.push(`${risk ? 'If you survive, it k' : 'K'}nocks ${foe.speciesName} out this turn (guaranteed).`);
        else if (ko > 0) headline.push(`${risk ? 'If you survive, it m' : 'M'}ay knock ${foe.speciesName} out this turn (about ${pctOf(ko)}% chance).`);
      }
      if (headline.length) body = parts.filter((p) => !/^(Danger|Warning|Risk):/.test(p));
    }
    const sureKo = !why && !(order === 'foe' && foeKo >= 0.3) && est && koChance(est, foe.hp) * ((move.accuracy || 100) / 100) >= 0.99;
    options.push({ key, kind: 'move', slot: i, moveId: id, sureKo, downsides: est ? moveDownsides(move, you.pp[i]) : [], text: arrange(body, headline), est, koChance: koChance(est, foe.hp), fails: !!why, accuracy: move.accuracy || 100, order });
  }
  // Overkill: name a clean move that also guarantees the knockout.
  const clean = options.filter((o) => o.sureKo && !o.downsides.length);
  for (const o of options.filter((o) => o.kind === 'move' && o.downsides.length && (o.sureKo || koChance(o.est, foe.hp) >= 0.99))) {
    const alt = clean.find((c) => c !== o);
    if (!alt) continue;
    const note = `Overkill: ${MOVE_DATA.get(alt.moveId).name} also guarantees this knockout, without ${o.downsides.join(' or ')}.`;
    o.text = layout === 'consequence' ? o.text.replace(/^((?:Knocks|May knock|Wasted|Will fail|Unreliable)[^.]*\.(?:\s|$))?/, (m) => `${m}${note} `).trim() : `${o.text} ${note}`;
  }
  // Binding moves, Mean Look and trapping abilities stop a switch (the game also refuses it).
  const trapped = (you.status2 & (0xE000 | 0x4000000)) || foe.ability === ABILITIES.byName.get('SHADOW_TAG');
  if (!trapped) {
    const recentlyOut = new Set(history.filter((h) => h.turn >= battle.turn - 2).map((h) => h.switchedOut).filter(Boolean));
    // RED's AI picks its move against the Pokémon it sees now.
    const likely = redMoves(foe, you, field)[0];
    const expected = likely?.avg ? likely : null;
    for (const mon of bench) {
      const key = `switch_${mon.speciesName.replace(/\W/g, '_')}`;
      if (excluded.has(key) || recentlyOut.has(mon.personality)) continue;
      // A switch costs a free hit on the incoming Pokémon, so it is only an
      // option when that Pokémon can take the hit: the expected attack does
      // little to it, and even RED's best attack against it doesn't knock it out.
      const taken = expected?.avg ? estimateDamage(expected.id, foe, mon, { weather: field.weather, defenderScreens: field.playerSide }) : null;
      const takenShare = taken && !taken.unknown ? taken.max / mon.hp : 0;
      const worst = threats(foe, mon, field)[0];
      const worstKo = worst ? koChance(worst.est, mon.hp) : 0;
      const doomed = you.perishCount === 0; // staying in means fainting this turn
      // Bait: filler may take a hit it won't survive, to save a reserved
      // Pokémon that is in danger; its faint then gives a free send-in.
      const bait = foeKo >= 0.3 && isReserved(battle.roles, you) && isFiller(battle.roles, mon);
      // With no damaging moves left, staying in achieves nothing: any switch-in
      // that survives the hit (a tank for the others) is offered.
      const lenient = doomed || noDamage;
      if (!bait && (lenient ? (takenShare >= 1 || worstKo >= 1) : (takenShare > 0.4 || worstKo > 0))) continue;
      const best = bestAttack(mon, foe, field);
      const order = speedOrder(mon, foe, 0, 0, field.weather);
      const absorb = !taken || taken.effectiveness === 0
        ? `${mon.speciesName} takes no damage from it (${taken ? 'immune' : 'not a damaging move'})`
        : `${mon.speciesName} takes ${damageWords(taken, mon)}`;
      const parts = [
        `Switch out to ${mon.speciesName} (${typesText(mon.types)}, HP ${pct(mon.hp, mon.maxHp)}%, ${statusText(mon.status1)}, holding ${itemName(mon.item)}).`,
        `Cost: you do no damage this turn and ${foe.speciesName} gets a free attack on ${mon.speciesName} as it comes in.`,
        expected ? `${foe.speciesName} will most likely use ${expected.move.name} (about ${pctOf(likely.p)}% likely against ${you.speciesName}); ${absorb}.`
          : likely ? `${foe.speciesName} will most likely use ${likely.move.name} (about ${pctOf(likely.p)}% likely), not an attack.` : '',
        worst && worst.id !== expected?.id ? `Its strongest attack on ${mon.speciesName} is ${worst.move.name}: ${damageWords(worst.est, mon)}.` : '',
        bait && takenShare >= 1
          ? `Sacrifice: ${mon.speciesName} is filler and would likely be knocked out coming in, but that saves ${you.speciesName}, which is reserved for ${battle.roles.get(you.personality).reservedFor.join(', ')}, and the faint lets you send in any Pokémon without it taking a hit.`
          : noDamage
          ? `Benefit: ${you.speciesName} has no damaging moves left, so it cannot knock ${foe.speciesName} out; ${mon.speciesName} can take the hit and attack.`
          : you.perishCount != null
          ? `Benefit: clears ${you.speciesName}'s Perish Song count (it would faint ${perishWhen(you.perishCount)}).`
          : foeKo >= 0.3 && youFiller && takenShare > 0
          ? `Little benefit: this saves ${you.speciesName}, but it is filler. Letting it faint instead brings in your next Pokémon for free, while this switch costs ${mon.speciesName} a hit.`
          : foeKo >= 0.3
          ? `Benefit: saves ${you.speciesName} (HP ${pct(you.hp, you.maxHp)}%), which ${foe.speciesName} would likely knock out this turn, for later.`
          : `No benefit: ${you.speciesName} is not in danger of being knocked out this turn, so switching does not save it.`,
        foe.perishCount != null ? `${foe.speciesName} still faints from Perish Song ${perishWhen(foe.perishCount)} if it stays in; ${mon.speciesName} has no count.` : '',
        takenShare >= 1 ? `${mon.speciesName} would most likely be knocked out coming in.`
          : best ? `From next turn, ${mon.speciesName}'s best attack, ${best.name}, would do ${damageWords(best.est, foe)}.` : `${mon.speciesName} has no attack that hurts ${foe.speciesName}.`,
        takenShare < 1 ? exchangeText(mon, foe, field, mon.hp - (taken && !taken.unknown ? (taken.min + taken.max) / 2 : 0)).replace('Exchange:', 'Exchange after coming in:') : '',
        order === 'foe' ? `${mon.speciesName} is slower than ${foe.speciesName}.` : `${mon.speciesName} is ${order === 'you' ? 'faster than' : 'as fast as'} ${foe.speciesName}.`,
        battle.roles ? `Role: ${roleText(battle.roles, mon)}` : '',
        recentSwitches >= 2 ? `Note: you have switched ${recentSwitches} times in the last 3 turns, and each switch gave ${foe.speciesName} a free attack.` : '',
      ];
      options.push({ key, kind: 'switch', personality: mon.personality, text: arrange(parts), mon });
    }
  }
  return options;
}

// Bench Pokémon that can come in after a faint.
export function buildSendInOptions(battle) {
  return applyFilter(buildAllSendInOptions(battle));
}
function buildAllSendInOptions(battle) {
  const { foe, bench, field } = battle;
  return bench.map((mon) => {
    const best = bestAttack(mon, foe, field);
    const order = speedOrder(mon, foe, 0, 0, field.weather);
    const parts = [
      `Send in ${mon.speciesName} (${typesText(mon.types)}, HP ${pct(mon.hp, mon.maxHp)}%, ${statusText(mon.status1)}, holding ${itemName(mon.item)}).`,
      `${mon.speciesName} is ${order === 'you' ? 'faster than' : order === 'foe' ? 'slower than' : 'as fast as'} ${foe.speciesName}.`,
      best ? `Its best attack, ${best.name}, would do ${damageWords(best.est, foe)}.` : `It has no attack that hurts ${foe.speciesName}.`,
      `${threatWords(foe, mon, field)}.`,
    ];
    const { ko } = redKo(foe, mon, field);
    if (order === 'foe' && ko >= LIKELY) {
      parts.push(layout === 'consequence'
        ? `Faints before attacking: ${foe.speciesName} is faster and would knock ${mon.speciesName} out (about ${pctOf(ko)}% chance) before it can attack.`
        : `Danger: ${foe.speciesName} is faster and would knock ${mon.speciesName} out (about ${pctOf(ko)}% chance) before it can attack.`);
    } else if (order === 'foe' && ko >= 0.3) {
      parts.push(`Risky: ${foe.speciesName} is faster and may knock ${mon.speciesName} out (about ${pctOf(ko)}% chance) before it can attack.`);
    }
    else if (order === 'you') parts.push(`${mon.speciesName} attacks first next turn.`);
    parts.push(exchangeText(mon, foe, field));
    if (battle.roles) parts.push(`Role: ${roleText(battle.roles, mon)}`);
    return { key: `send_${mon.speciesName.replace(/\W/g, '_')}`, kind: 'switch', personality: mon.personality, text: arrange(parts), mon };
  });
}


// --- Roles: reserved answers vs filler ---------------------------------------------------------
// Before the battle and after every faint, the model picks the best answer
// among your Pokémon to each of RED's remaining Pokémon. A Pokémon picked
// for a RED Pokémon that isn't out yet is "reserved" for it; one picked for
// the Pokémon that is out now is its "answer"; the rest are "filler" that can
// be traded. The one-on-one numbers are worked out here.
export function matchup(mon, red, field) {
  const ours = bestAttack(mon, red, field);
  const [theirs] = threats(red, mon, field);
  const order = speedOrder(mon, red, 0, 0, field.weather);
  // The same one-on-one simulation as the options' "Exchange:" line, so roles and options agree.
  const x = exchange(mon, red, field);
  const wins = !!x && x.pWin >= 0.5;
  const outcome = !x ? 'Neither side can hurt the other.'
    : x.pWin >= 0.5 ? `It wins this one-on-one about ${pctOf(x.pWin)}% of the time, usually with about ${Math.max(1, pctOf(x.winLeft))}% HP left.`
    : x.pLose >= 0.5 ? `It loses this one-on-one about ${pctOf(x.pLose)}% of the time, taking off about ${Math.min(99, pctOf(x.loseDealt))}% of ${red.speciesName}'s HP first.`
    : `Neither side usually wins within 15 turns (it wins ${pctOf(x.pWin)}%).`;
  const text = [
    `${mon.speciesName} (${typesText(mon.types)}, HP ${pct(mon.hp, mon.maxHp)}%):`,
    ours ? `its ${ours.name} does ${damageWords(ours.est, red)};` : `it has no attack that hurts ${red.speciesName};`,
    theirs?.avg ? `${red.speciesName}'s ${theirs.move.name} does ${damageWords(theirs.est, mon)};` : `${red.speciesName} has no attack that hurts it;`,
    `${mon.speciesName} is ${order === 'you' ? 'faster' : order === 'foe' ? 'slower' : 'equally fast'}.`,
    outcome,
  ].join(' ');
  // Chance of winning first, then HP kept when winning and damage dealt when losing.
  const score = !x ? 0 : x.pWin + 0.3 * x.pWin * (x.winLeft ?? 0) + 0.3 * x.pLose * (x.loseDealt ?? 0) - 0.3 * x.pLose;
  return { text, wins, score };
}

const ROLE_CONSIDERATIONS = [
  'The best answer knocks that Pokémon out before being knocked out by it: faster and able to hit hard, or bulky enough to take several hits.',
  'If one of the player\'s Pokémon is the only good answer to a RED Pokémon, it should be saved for it.',
];

export function buildRoleItems(ours, reds, field = { weather: {}, playerSide: {}, foeSide: {} }) {
  return reds.map((red, i) => ({
    name: `answer_${i}`,
    red,
    question: {
      goal: GOAL,
      question: `Which of the player's Pokémon is the best answer to RED's ${red.speciesName}: the one to keep healthy for when ${red.speciesName} is in battle?`,
      considerations: ROLE_CONSIDERATIONS,
    },
    noneText: `None of the player's Pokémon handles ${red.speciesName} well.`,
    options: ours.map((mon) => ({ key: `mon_${mon.speciesName.replace(/\W/g, '_')}`, mon, ...matchup(mon, red, field) })),
  }));
}

function roleState(ours, reds) {
  return {
    your_pokemon: ours.map((m) => `${m.speciesName} (${typesText(m.types)}, HP ${pct(m.hp, m.maxHp)}%)`),
    red_remaining_pokemon: reds.map((m) => `${m.speciesName} (${typesText(m.types)}, HP ${pct(m.hp, m.maxHp)}%${m.active ? ', in battle now' : ''})`),
  };
}

// Picks per RED Pokémon -> each of our Pokémon's role.
export function resolveRoles(items, picks, activeFoe) {
  const roles = new Map(); // personality -> { reservedFor: [], answerTo: [] }
  const plan = [];
  for (const item of items) {
    const pick = picks[item.name];
    const option = pick && pick.noGoodOption < 0.5 ? item.options.find((o) => o.key === pick.choice) : null;
    plan.push({ red: item.red.speciesName, answer: option?.mon.speciesName ?? null, share: option ? pick.probabilities[pick.choice] : null });
    if (!option) continue;
    const role = roles.get(option.mon.personality) ?? { reservedFor: [], answerTo: [] };
    (item.red.speciesName === activeFoe ? role.answerTo : role.reservedFor).push(item.red.speciesName);
    roles.set(option.mon.personality, role);
  }
  return { roles, plan };
}

export function roleText(roles, mon) {
  const role = roles?.get(mon.personality);
  if (!role) return `${mon.speciesName} is filler: not the planned answer to any of RED's Pokémon, so it can be traded.`;
  const parts = [];
  if (role.answerTo.length) parts.push(`the planned answer to ${role.answerTo.join(', ')}`);
  if (role.reservedFor.length) parts.push(`reserved as the answer to ${role.reservedFor.join(', ')} (not in battle yet)`);
  return `${mon.speciesName} is ${parts.join(' and ')}.`;
}

const isReserved = (roles, mon) => (roles?.get(mon.personality)?.reservedFor.length ?? 0) > 0;
const isFiller = (roles, mon) => roles && !roles.get(mon.personality);

// --- RED's team from the source, for planning the lead before the battle -------------------------
// RED's party (from Daily Red's src/dailyred_boss.c, via data.mjs) as
// level 100 Pokémon with his EVs, IVs 31 and neutral natures.
// RED's party (Daily Red's src/dailyred_boss.c, via data.mjs) as level 100
// Pokémon with his EVs, IVs 31 and neutral natures.
export function redTeamFromSource() {
  return RED_PARTY.map((m) => {
    const { species } = m;
    const data = SPECIES_DATA.get(species);
    const ev = m.evs;
    const stat = (k) => Math.floor(((2 * data.base[k] + 31 + Math.floor(ev[k] / 4)) * 100) / 100) + 5; // neutral nature
    const maxHp = Math.floor(((2 * data.base[0] + 31 + Math.floor(ev[0] / 4)) * 100) / 100) + 110;
    return {
      species, speciesName: speciesName(species), level: 100, hp: maxHp, maxHp,
      stats: { atk: stat(1), def: stat(2), spe: stat(3), spa: stat(4), spd: stat(5) },
      moves: m.moves,
      ivs: [31, 31, 31, 31, 31, 31], stages: [6, 6, 6, 6, 6, 6, 6, 6], ability: data.abilities[0], types: data.types,
      friendship: 255, item: m.item, status1: 0, status2: 0,
    };
  });
}

// Lead candidates: each of our Pokémon against RED's first Pokémon, plus how
// many of RED's team it can hit hard.
// Lead candidates against RED's first Pokémon. Like turn options: the
// consequence comes first (who attacks first, whether the first attack knocks
// it out counting accuracy, and what leading costs in terms of roles), then
// the details.
// Which of RED's other Pokémon `mon` beats one-on-one, and whether another
// Pokémon in the party beats them too; with `hpAfter` (its HP after the lead
// exchange), also how much of that it keeps once it has taken the lead's damage.
// A lead that wins easily keeps its later value; one that wins hurt spends it.
function laterValue(mon, party, reds, field, hpAfter = mon.hp) {
  const only = [], best = [], also = [], lost = [];
  for (const r of reds) {
    const mine = exchange(mon, r, field)?.pWin ?? 0;
    if (mine < 0.5) continue;
    const others = party.filter((m) => m !== mon).map((m) => ({ m, p: exchange(m, r, field)?.pWin ?? 0 })).sort((a, b) => b.p - a.p);
    const next = others[0];
    const item = `${r.speciesName} (${pctOf(mine)}%${next && next.p >= 0.5 ? `; ${next.m.speciesName} ${pctOf(next.p)}%` : ''})`;
    if (!next || next.p < 0.5) only.push(item);
    else if (mine >= next.p) best.push(item);
    else also.push(item);
    // What leading would cost here: its win chance after the lead's damage,
    // against the best the rest of the party can do.
    if (hpAfter < mon.hp && (!next || mine > next.p)) {
      const hurt = exchange(mon, r, field, hpAfter)?.pWin ?? 0;
      const fallback = Math.max(hurt, next?.p ?? 0);
      if (mine - fallback >= 0.15) lost.push(`against ${r.speciesName} your best chance drops from ${pctOf(mine)}% to ${pctOf(fallback)}%`);
    }
  }
  const parts = [];
  if (only.length) parts.push(`it is your only Pokémon that beats ${only.join(', ')}`);
  if (best.length) parts.push(`it is your best answer to ${best.join(', ')}`);
  if (also.length) parts.push(`it also beats ${also.join(', ')}, where another Pokémon does better`);
  return {
    text: parts.length ? `Later in the battle (win chance one-on-one at full HP): ${parts.join('; ')}.`
      : `Later in the battle: it does not win a one-on-one against any of RED's other Pokémon.`,
    cost: !lost.length ? (only.length || best.length
        ? `Lead cost: none: it should keep enough HP to still be your best answer to ${[...only, ...best].map((x) => x.split(' (')[0]).join(', ')}.`
        : `Lead cost: none: ${mon.speciesName} is not your best answer to any of RED's other Pokémon, so losing it here costs nothing later.`)
      : hpAfter <= 1 ? `Lead cost: ${mon.speciesName} most likely faints in the lead, so ${lost.join('; ')}.`
      : `Lead cost: with the HP it would have left after the lead, ${lost.join('; ')}.`,
  };
}

export function buildLeadOptions(party, redTeam, roles = null) {
  const lead = redTeam[0];
  const field = { weather: {}, playerSide: {}, foeSide: {} };
  return party.map((mon) => {
    const best = bestAttack(mon, lead, field);
    const move = best ? MOVE_DATA.get(best.id) : null;
    const acc = (move?.accuracy || 100) / 100;
    const ko = best ? koChance(best.est, lead.hp) * acc : 0;
    const order = speedOrder(mon, lead, 0, 0, {});
    const leadKo = redKo(lead, mon, field);
    const theirs = leadKo.move ?? threats(lead, mon, field)[0];
    const foeKo = leadKo.ko;
    const taken = theirs?.est && !theirs.est.unknown ? `${Math.min(100, pct(theirs.est.min, mon.hp))}-${Math.min(100, pct(theirs.est.max, mon.hp))}% of its HP` : 'little damage';
    // What leading costs and what this Pokémon is worth later, from the same
    // simulated one-on-ones: against RED's lead now, and against each of RED's
    // other Pokémon compared with the rest of the party.
    const now = exchange(mon, lead, field);
    const hpAfter = now && now.pWin >= 0.5 ? Math.max(1, Math.round(now.winLeft * mon.maxHp)) : 0;
    const later = laterValue(mon, party, redTeam.slice(1), field, hpAfter);

    const headline = [];
    if (order === 'foe' && foeKo >= LIKELY) {
      headline.push(`Faints before attacking: ${lead.speciesName} is faster and its ${theirs.move.name} knocks ${mon.speciesName} out (about ${pctOf(foeKo)}% chance).`);
    } else {
      if (order === 'foe' && foeKo >= 0.3) headline.push(`Risky: ${lead.speciesName} is faster and may knock ${mon.speciesName} out (about ${pctOf(foeKo)}% chance) before it attacks.`);
      const first = order === 'foe' ? `after taking ${lead.speciesName}'s first hit (${taken}), ` : `before ${lead.speciesName} can act, `;
      if (ko >= 0.99) headline.push(`Knocks ${lead.speciesName} out with its first attack (${best.name}, guaranteed), ${first.replace(/, $/, '')}.`);
      else if (ko > 0) headline.push(`May knock ${lead.speciesName} out with its first attack (${best.name}: about ${Math.round(ko * 100)}% chance${acc < 1 ? `, counting its ${move.accuracy}% accuracy` : ''}), ${first.replace(/, $/, '')}.`);
      else headline.push(`Can't knock ${lead.speciesName} out in one attack.`);
    }
    if (later.cost) headline.unshift(later.cost); // the whole-battle cost first, before the first exchange
    if (now && now.pWin >= 0.5) { const nx = nextFoeText(mon, lead, redTeam, field, hpAfter, 'faints to it', party); if (nx) headline.push(nx); }
    // (No role-based "Cost"/"Benefit" headline here: the computed lead cost
    // above says what leading spends, and the two used to contradict each other.)
    if (move?.effect === 'RECHARGE' && ko > 0 && !(now?.pWin >= 0.5 && now.recharge)) headline.push(`Recharge cost: after ${best.name} it can't act next turn, so RED's next Pokémon gets a free attack.`);
    if (now) headline.push(now.pWin >= 0.5
      ? `Lead exchange: ${mon.speciesName} beats ${lead.speciesName} about ${pctOf(now.pWin)}% of the time${usingText(now, lead)}, usually with about ${Math.max(1, pctOf(now.winLeft))}% HP left for later.`
      : `Lead exchange: ${lead.speciesName} beats ${mon.speciesName} about ${pctOf(now.pLose)}% of the time${(now.loseDealt ?? 0) >= 0.01 ? `; ${mon.speciesName} takes off about ${Math.min(99, pctOf(now.loseDealt))}% of its HP first` : `, usually before ${mon.speciesName} can do damage`}.`);

    const parts = [
      `Lead with ${mon.speciesName} (${typesText(mon.types)}, holding ${itemName(mon.item)}; moves: ${mon.moves.filter(Boolean).map((id) => MOVE_DATA.get(id).name).join(', ')}).`,
      `${mon.speciesName} is ${order === 'you' ? 'faster than' : order === 'foe' ? 'slower than' : 'as fast as'} ${lead.speciesName}.`,
      best ? `Its best attack, ${best.name}, would do ${acc < 1 ? damageWords(best.est, lead).replace('guaranteed to knock it out', 'knocks it out if it hits') : damageWords(best.est, lead)}.` : `It has no attack that hurts ${lead.speciesName}.`,
      best ? (contactWarning(move, mon, lead) ?? '') : '',
      `${threatWords(lead, mon, field)}.`,
      later.text,
      roles ? `Role: ${roleText(roles, mon)}` : '',
    ].filter(Boolean);
    const text = layout === 'consequence' ? [...headline, ...parts].join(' ') : [...parts, ...headline].join(' ');
    return { key: `lead_${mon.speciesName.replace(/\W/g, '_')}`, kind: 'lead', personality: mon.personality, text, mon };
  });
}

// --- Jev ------------------------------------------------------------------------------------------
// Plain context about the domain, shared by every question for both models:
// battle text ("faint", "knocked out", Self-Destruct) is game vocabulary.
const GOAL = 'This is a turn-based Pokémon video game. "Faint" and "knocked out" are game terms for a Pokémon losing all its HP and leaving the battle. You are the player in a single (one-on-one) level 100 Pokémon battle in Pokémon FireRed (Generation 3 rules) against RED, the strongest trainer. You win only by knocking out all of RED\'s Pokémon. RED\'s AI usually attacks with its strongest move, but also uses status and healing moves; the options already account for the moves it is likely to pick.';

export const ACTION_QUESTION = {
  goal: GOAL,
  question: 'Which action should the player take this turn to give the best chance of winning the whole battle?',
  considerations: [
    'Knocking out the foe before it can act is very valuable, especially when the foe would knock out the active Pokémon or do heavy damage.',
    'A move only happens if the user is still standing when its turn comes: when the foe moves first and knocks the active Pokémon out, the chosen move does nothing.',
    'Switching Pokémon has a cost: RED gets a free attack on the incoming Pokémon. Only switch to save the current Pokémon for later, when the incoming Pokémon can take the hit (best of all, an attack it is immune to, like a Ground move into a Flying type), or to make RED use up the PP of a dangerous move. Do not keep switching.',
    'A move that will fail, or has no effect, wastes the turn.',
    'If the active Pokémon has no damaging moves left, switch to a Pokémon that can take the hit for the others, or use a status move that helps (Perish Song, Toxic, paralysis); repeated Protect only delays.',
    'Once Perish Song is in effect, the countdown is the knockout: stall (Protect, or switch into a Pokémon that can take hits) until the foe\'s count runs out, and switch your own Pokémon out before its count reaches zero. RED switches out on its last turn unless it is trapped.',
    'Status moves and stat boosts are worth it only when there is time to benefit before being knocked out.',
    'Reserved Pokémon are the planned answers to RED Pokémon that are not out yet: keep them healthy for those. Filler Pokémon can be traded: switched in to take a hit, or even sacrificed so a reserved Pokémon is saved and can come in safely after the faint.',
    'A filler Pokémon being knocked out is acceptable: after a faint the next Pokémon comes in without taking a hit, which is cheaper than switching. Attack with filler until it faints rather than switching it out to save it.',
  ],
};

export const SEND_IN_QUESTION = {
  goal: GOAL,
  question: 'One of the player\'s Pokémon just fainted. Which Pokémon should the player send in against RED\'s active Pokémon to give the best chance of winning the whole battle?',
  considerations: [
    'The Pokémon sent in does not take a hit on the way in, but on the next turn the faster Pokémon attacks first. A slower Pokémon that the foe can knock out in one hit faints without attacking.',
    'Prefer a Pokémon that can knock out the foe before it is knocked out itself: either faster than the foe, or able to survive its strongest attack.',
    'Prefer the planned answer to the Pokémon in battle, or filler; avoid spending a Pokémon reserved for a RED Pokémon that is not out yet.',
    'Keep Pokémon that are good answers to RED\'s other remaining Pokémon for later.',
  ],
};

export const LEAD_QUESTION = {
  goal: GOAL,
  question: 'Which Pokémon should the player lead with (send out first) to give the best chance of winning the whole battle? RED always leads with the Pokémon described in `red_team[0]`.',
  considerations: [
    'A good lead beats RED\'s lead: it is not knocked out quickly and can knock RED\'s lead out.',
    'The whole battle matters more than the first exchange: each option\'s "Lead cost" says how much leading with it lowers your chances against RED\'s later Pokémon. A Pokémon that is not needed later is cheap to trade; one that is your best answer to a later Pokémon is expensive to spend unless it keeps its HP.',
  ],
};

const OUTLOOK_QUESTION = {
  goal: GOAL,
  question: 'How is the battle going for the player right now?',
};
// Asked next to the outlook: the outlook's levels are ordered (losing ...
// winning), so "too early to tell" can't be one of them. Code uses this
// probability to decide whether the outlook means anything yet.
const TOO_EARLY_QUESTION = {
  goal: GOAL,
  question: 'Is it still too early to tell who will win this battle?',
};
const TOO_EARLY_CRITERIA = {
  true: 'The outcome is still open: neither side has a clear advantage yet, and the battle could go either way depending on the turns ahead.',
  false: 'One side already has a clear advantage that is likely to decide the battle.',
};

const OUTLOOK_LEVELS = [
  'The player is almost certainly losing',
  'The player is behind',
  'The battle is even',
  'The player is ahead',
  'The player is almost certainly winning',
];

// Asks the same Choice twice with the options in opposite orders and
// averages the two distributions (Jev can be swayed by option order).
// Every choice also offers "none of these is good". Without it OpenAI's
// Decisions API refuses to answer in hopeless positions, and both providers
// recommend a no-match outcome. The agent still has to act, so it plays the
// best real option and keeps the "nothing is good" probability for the log.
const NO_GOOD = 'no_good_option';
const NO_GOOD_TEXT = 'None of these actions is a good option.';

// How many option orders each choice is asked in (play.mjs --orders). Order 1
// is as listed, 2 reversed, 3 and 4 rotated so the middle options come first;
// more orders rotate further. "None of these" always stays last.
let orderCount = 2;
export function setOrderCount(n) { orderCount = Math.max(1, Math.floor(n)); }
const ORDER_NAMES = 'abcdefghij'.split('');

function orderings(options) {
  const rotate = (list, k) => [...list.slice(k), ...list.slice(0, k)];
  const half = Math.ceil(options.length / 2);
  const all = [options, [...options].reverse(), rotate(options, half), [...rotate(options, half)].reverse()];
  for (let k = 1; all.length < orderCount; k++) all.push(rotate(options, k % options.length));
  return all.slice(0, orderCount);
}

// One Choice per order, keyed pick_a, pick_b, pick_c...
function choiceQuestions(question, options, noneText = NO_GOOD_TEXT) {
  return Object.fromEntries(orderings(options).map((order, i) => [`pick_${ORDER_NAMES[i]}`, {
    type: 'choice', instructions: question,
    criteria: Object.fromEntries([...order.map((o) => [o.key, o.text]), [NO_GOOD, noneText]]),
  }]));
}

// Averages the orders' probabilities (missing ones, e.g. a refused order, are
// skipped). Also reports how many orders had the final pick on top.
function averaged(answers, options) {
  const dists = Object.values(answers).filter((a) => a?.probabilities).map((a) => a.probabilities);
  const avg = (key) => dists.reduce((sum, d) => sum + (d[key] ?? 0), 0) / dists.length;
  const noGood = avg(NO_GOOD);
  // Renormalize over the real options so the shares stay comparable.
  const rest = Math.max(1e-9, 1 - noGood);
  const ranked = options.map((o) => [o.key, avg(o.key) / rest]).sort((a, b) => b[1] - a[1]);
  const tops = dists.map((d) => options.map((o) => o.key).sort((a, b) => (d[b] ?? 0) - (d[a] ?? 0))[0]);
  return {
    choice: ranked[0][0], probabilities: Object.fromEntries(ranked), noGoodOption: noGood,
    orderTops: tops, ordersAgreeing: tops.filter((t) => t === ranked[0][0]).length,
  };
}
// Jev normally gets its instructions as structured JSON; "flat" sends the
// same words as one string, the way OpenAI's Decisions API takes them.
let instructionStyle = 'structured';
export function setInstructionStyle(style) { instructionStyle = style; }
const jevInstructions = (q) => (instructionStyle === 'flat' ? instructionText(q) : q);

// Score mode: each option rated on its own instead of one Choice between them,
// so option order can't matter. Code picks the highest expected score.
const SCORE_LEVELS = [
  'A clear mistake: it wastes the turn or loses a Pokémon for nothing',
  'A poor choice: a clearly better option exists',
  'Reasonable, but probably not the best option',
  'A good choice',
  'The best possible action in this position',
];
function scoreQuestion(question, option) {
  return {
    goal: question.goal,
    action: option.text,
    question: 'How good is `action` for winning the whole battle, compared with the other things the player could do this turn?',
    considerations: question.considerations,
  };
}
function fromScores(scores, options) {
  const ranked = options.map((o) => [o.key, scores[o.key] ?? 0]).sort((a, b) => b[1] - a[1]);
  return { choice: ranked[0][0], probabilities: Object.fromEntries(ranked), scores };
}

let decisionMode = 'choice';
export function setDecisionMode(mode) { decisionMode = mode; }
// Hybrid: rate each option, drop those rated a mistake or poor (below 1.5 of
// 4), then ask the usual Choice among the rest. Keeps at least two options.
export async function decide(brain, state, question, options, extra) {
  if (options.length < 2 || decisionMode === 'choice') return brain.ask(state, question, options, extra);
  const rated = await brain.askScores(state, question, options);
  if (decisionMode === 'score') return rated;
  const ranked = [...options].sort((a, b) => rated.scores[b.key] - rated.scores[a.key]);
  const kept = ranked.filter((o) => rated.scores[o.key] >= 1.5);
  const shortlist = kept.length >= 2 ? kept : ranked.slice(0, 2);
  const chosen = await brain.ask(state, question, shortlist, extra);
  return { ...chosen, filteredOut: options.length - shortlist.length, optionScores: rated.scores, latencyMs: (chosen.latencyMs ?? 0) + (rated.latencyMs ?? 0) };
}

// The answers to one item's order questions, from a response keyed `${prefix}${letter}`.
const orderAnswers = (get, prefix) => Object.fromEntries(ORDER_NAMES.slice(0, orderCount).map((l) => [l, get(`${prefix}${l}`)]));

export class JevBrain {
  constructor({ model } = {}) {
    this.client = new TypeSafeClient(model ? { defaultModel: model } : {});
    this.usage = { input_tokens: 0, output_tokens: 0, requests: 0, latencies: [] };
  }

  async ask(state, question, options, extra = {}) {
    if (options.length === 1) return { choice: options[0].key, probabilities: { [options[0].key]: 1 }, single: true };
    const request = { state, questions: { ...choiceQuestions(jevInstructions(question), options), ...extra } };
    const started = performance.now();
    const res = await this.client.systemOne(request);
    const latencyMs = Math.round(performance.now() - started);
    this.usage.latencies.push(latencyMs);
    this.usage.input_tokens += res.usage.input_tokens;
    this.usage.output_tokens += res.usage.output_tokens;
    this.usage.requests++;
    const result = averaged(orderAnswers((k) => res.answers[k], 'pick_'), options);
    if (res.answers.outlook) { result.outlook = res.answers.outlook.score; result.outlookConfidence = res.answers.outlook.confidence; }
    if (res.answers.too_early) result.tooEarly = res.answers.too_early.noul;
    result.model = res.model;
    result.latencyMs = latencyMs;
    result.request = { model: this.client.defaultModel, ...request };
    result.response = { model: res.model, answers: res.answers, usage: res.usage };
    return result;
  }

  chooseAction(battle, options) {
    return decide(this, turnState(battle), ACTION_QUESTION, options, {
      outlook: { type: 'score', instructions: OUTLOOK_QUESTION, criteria: OUTLOOK_LEVELS },
      too_early: { type: 'noul', instructions: TOO_EARLY_QUESTION, criteria: TOO_EARLY_CRITERIA },
    });
  }

  chooseSendIn(battle, options) {
    return decide(this, turnState(battle), SEND_IN_QUESTION, options);
  }

  chooseLead(party, redTeam, options) {
    return this.ask(leadState(party, redTeam), LEAD_QUESTION, options);
  }

  // Score mode: one Score question per option in a single request.
  async askScores(state, question, options) {
    const questions = Object.fromEntries(options.map((o, i) => [`score_${i}`,
      { type: 'score', instructions: jevInstructions(scoreQuestion(question, o)), criteria: SCORE_LEVELS }]));
    const request = { state, questions };
    const started = performance.now();
    const res = await this.client.systemOne(request);
    const latencyMs = Math.round(performance.now() - started);
    this.usage.latencies.push(latencyMs);
    this.usage.input_tokens += res.usage.input_tokens;
    this.usage.output_tokens += res.usage.output_tokens;
    this.usage.requests++;
    const scores = Object.fromEntries(options.map((o, i) => [o.key, res.answers[`score_${i}`]?.score ?? 0]));
    return { ...fromScores(scores, options), latencyMs, request: { model: this.client.defaultModel, ...request }, response: { model: res.model, answers: res.answers, usage: res.usage } };
  }

  // One request with a Choice (asked in both orders) per RED Pokémon.
  async chooseRoles(ours, reds, items) {
    const questions = {};
    for (const it of items) {
      for (const [key, q] of Object.entries(choiceQuestions(it.question, it.options, it.noneText))) {
        questions[`${it.name}_${key.slice(5)}`] = q;
      }
    }
    const request = { state: roleState(ours, reds), questions };
    const started = performance.now();
    const res = await this.client.systemOne(request);
    const latencyMs = Math.round(performance.now() - started);
    this.usage.latencies.push(latencyMs);
    this.usage.input_tokens += res.usage.input_tokens;
    this.usage.output_tokens += res.usage.output_tokens;
    this.usage.requests++;
    const picks = Object.fromEntries(items.map((it) => [it.name, averaged(orderAnswers((k) => res.answers[k], `${it.name}_`), it.options)]));
    return { picks, latencyMs, request: { model: this.client.defaultModel, ...request }, response: { model: res.model, answers: res.answers, usage: res.usage } };
  }
}

// The same decisions made by OpenAI's Decisions API (POST /v1/decisions)
// instead of Jev, for comparison. It is the same kind of model: typed choice
// and score questions answered with a probability for every option. It gets
// the same state, guidance and option descriptions, with the same averaging
// over option orders. Its instructions must be plain text, so the guidance is joined
// into one string. https://developers.openai.com/api/docs/guides/decisions
const instructionText = (q) => [q.goal, q.question, ...(q.considerations ?? []).map((c) => `- ${c}`)].join('\n');

export class OpenAIBrain {
  constructor({ model } = {}) {
    // Replays send many requests at once and can hit the tokens-per-minute
    // limit (429); retry those with backoff instead of failing the decision.
    this.client = new OpenAI({ maxRetries: 6 });
    this.model = model ?? 'gpt-6-luna';
    this.usage = { input_tokens: 0, output_tokens: 0, requests: 0, latencies: [] };
  }

  async ask(state, question, options, { outlook = false } = {}) {
    if (options.length === 1) return { choice: options[0].key, probabilities: { [options[0].key]: 1 }, single: true };
    const toChoices = (criteria) => Object.entries(criteria).map(([value, description]) => ({ value, description }));
    const questions = Object.entries(choiceQuestions(question, options)).map(([name, q]) => (
      { type: 'choice', name, instructions: instructionText(question), choices: toChoices(q.criteria) }));
    if (outlook) {
      questions.push({ type: 'score', name: 'outlook', instructions: instructionText(OUTLOOK_QUESTION), levels: OUTLOOK_LEVELS.map((label) => ({ label })) });
      questions.push({ type: 'predicate', name: 'too_early', instructions: `${instructionText(TOO_EARLY_QUESTION)}\nYes: ${TOO_EARLY_CRITERIA.true}\nNo: ${TOO_EARLY_CRITERIA.false}` });
    }
    const request = { model: this.model, input: JSON.stringify(state, null, 2), questions };
    const started = performance.now();
    const res = await this.client.decisions.create(request);
    const latencyMs = Math.round(performance.now() - started);
    this.usage.latencies.push(latencyMs);
    this.usage.input_tokens += res.usage?.input_tokens ?? 0;
    this.usage.output_tokens += res.usage?.output_tokens ?? 0;
    this.usage.requests++;
    const byName = Object.fromEntries(res.answers.map((a) => [a.name, a]));
    const asProbs = (a) => (a?.type === 'choice' ? Object.fromEntries(a.probabilities.map((p) => [p.value, p.probability])) : null);
    const answers = orderAnswers((k) => { const p = asProbs(byName[k]); return p && { probabilities: p }; }, 'pick_');
    if (!Object.values(answers).some(Boolean)) throw new RefusalError(res.answers, latencyMs, request);
    const result = averaged(answers, options);
    if (byName.outlook?.type === 'score') { result.outlook = byName.outlook.score; result.outlookConfidence = byName.outlook.confidence; }
    if (byName.too_early?.type === 'predicate') result.tooEarly = byName.too_early.probability;
    result.model = res.model;
    result.latencyMs = latencyMs;
    result.request = request;
    result.response = { model: res.model, answers: res.answers, usage: res.usage };
    return result;
  }

  async askScores(state, question, options) {
    const questions = options.map((o, i) => {
      const q = scoreQuestion(question, o);
      return { type: 'score', name: `score_${i}`, instructions: `${instructionText(question).replace(question.question, q.question.replace('`action`', 'this action'))}\nAction: ${o.text}`, levels: SCORE_LEVELS.map((label) => ({ label })) };
    });
    const request = { model: this.model, input: JSON.stringify(state, null, 2), questions };
    const started = performance.now();
    const res = await this.client.decisions.create(request);
    const latencyMs = Math.round(performance.now() - started);
    this.usage.latencies.push(latencyMs);
    this.usage.input_tokens += res.usage?.input_tokens ?? 0;
    this.usage.output_tokens += res.usage?.output_tokens ?? 0;
    this.usage.requests++;
    const byName = Object.fromEntries(res.answers.map((a) => [a.name, a]));
    const scores = Object.fromEntries(options.map((o, i) => [o.key, byName[`score_${i}`]?.type === 'score' ? byName[`score_${i}`].score : 0]));
    return { ...fromScores(scores, options), latencyMs, request, response: { model: res.model, answers: res.answers, usage: res.usage } };
  }

  // The Decisions API can answer a question with a refusal (no reason given).
  // Ask once more; if it refuses again, use the greedy pick for this decision.
  async withFallback(ask, greedy) {
    const refusals = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await ask(); } catch (e) {
        if (!(e instanceof RefusalError)) throw e;
        this.usage.refusals = (this.usage.refusals ?? 0) + 1;
        refusals.push({ request: e.request, answers: e.answers, latencyMs: e.latencyMs });
      }
    }
    // Keep the refused requests so the log shows exactly what was asked.
    return { ...(await greedy()), refused: true, refusals };
  }

  chooseAction(battle, options) {
    return this.withFallback(() => decide(this, turnState(battle), ACTION_QUESTION, options, { outlook: true }),
      () => new GreedyBrain().chooseAction(battle, options));
  }

  chooseSendIn(battle, options) {
    return this.withFallback(() => decide(this, turnState(battle), SEND_IN_QUESTION, options),
      () => new GreedyBrain().chooseSendIn(battle, options));
  }

  chooseLead(party, redTeam, options) {
    return this.withFallback(() => this.ask(leadState(party, redTeam), LEAD_QUESTION, options),
      () => new GreedyBrain().chooseLead(party, redTeam, options));
  }

  async chooseRoles(ours, reds, items) {
    const toChoices = (criteria) => Object.entries(criteria).map(([value, description]) => ({ value, description }));
    const questions = items.flatMap((it) => {
      return Object.entries(choiceQuestions(it.question, it.options, it.noneText)).map(([key, q]) => (
        { type: 'choice', name: `${it.name}_${key.slice(5)}`, instructions: instructionText(it.question), choices: toChoices(q.criteria) }));
    });
    const request = { model: this.model, input: JSON.stringify(roleState(ours, reds), null, 2), questions };
    const started = performance.now();
    const res = await this.client.decisions.create(request);
    const latencyMs = Math.round(performance.now() - started);
    this.usage.latencies.push(latencyMs);
    this.usage.input_tokens += res.usage?.input_tokens ?? 0;
    this.usage.output_tokens += res.usage?.output_tokens ?? 0;
    this.usage.requests++;
    const byName = Object.fromEntries(res.answers.map((a) => [a.name, a]));
    const asProbs = (a) => (a?.type === 'choice' ? Object.fromEntries(a.probabilities.map((p) => [p.value, p.probability])) : null);
    const greedy = (await new GreedyBrain().chooseRoles(ours, reds, items)).picks;
    const picks = {};
    for (const it of items) {
      const answers = orderAnswers((k) => { const p = asProbs(byName[k]); return p && { probabilities: p }; }, `${it.name}_`);
      if (!Object.values(answers).some(Boolean)) { this.usage.refusals = (this.usage.refusals ?? 0) + 1; picks[it.name] = { ...greedy[it.name], refused: true }; continue; }
      picks[it.name] = averaged(answers, it.options);
    }
    return { picks, latencyMs, request, response: { model: res.model, answers: res.answers, usage: res.usage } };
  }
}

class RefusalError extends Error {
  constructor(answers, latencyMs, request) {
    super(`OpenAI Decisions refused: ${JSON.stringify(answers.map((a) => `${a.name}:${a.type}`))}`);
    this.answers = answers;
    this.latencyMs = latencyMs;
    this.request = request;
  }
}

// A simple baseline without a model: the strongest attack, the healthiest
// matchup when sending in, and the best one-on-one for each role. Used for
// --policy greedy and as the fallback when OpenAI refuses.
export class GreedyBrain {
  pick(options, score) {
    const ranked = [...options].sort((a, b) => score(b) - score(a));
    return { choice: ranked[0].key, probabilities: Object.fromEntries(ranked.map((o, i) => [o.key, i === 0 ? 1 : 0])) };
  }
  async chooseAction(battle, options) {
    return this.pick(options, (o) => (o.kind !== 'move' ? -1 : o.fails ? -2
      : (o.koChance * 1000) + (o.est ? ((o.est.min + o.est.max) / 2) * (o.accuracy / 100) : 0)));
  }
  async chooseSendIn(battle, options) {
    return this.pick(options, (o) => { const b = bestAttack(o.mon, battle.foe, battle.field); return b ? b.avg / battle.foe.hp : 0; });
  }
  async chooseLead(party, redTeam, options) {
    return this.pick(options, (o) => { const b = bestAttack(o.mon, redTeam[0], { weather: {}, foeSide: {} }); return b ? b.avg / redTeam[0].maxHp : 0; });
  }
  async chooseRoles(ours, reds, items) {
    const picks = {};
    for (const it of items) {
      const best = [...it.options].sort((a, b) => b.score - a.score)[0];
      picks[it.name] = { choice: best.key, probabilities: { [best.key]: 1 }, noGoodOption: best.wins ? 0 : 1 };
    }
    return { picks };
  }
}

// A 2-turn lookahead written in code, as a stronger no-model baseline: each
// option is played out for this turn and the next with expected damage (our
// attack, the foe's best reply, speed order, recharge, Toxic, boosts), and
// scored by the share of the foe's HP removed minus the share of ours lost,
// with a bonus for knocking it out and a penalty for being knocked out.
function playOut({ us, foe, field, firstTurn, laterTurns, ourHp = us.hp }) {
  const [reply] = threats(foe, us, field);
  const theirs = reply?.avg ? reply.avg * ((reply.move.accuracy || 100) / 100) : 0;
  const weFirst = speedOrder(us, foe, firstTurn.priority ?? 0, reply?.move.priority ?? 0, field.weather) === 'you';
  let mine = ourHp, them = foe.hp;
  for (const [t, turn] of [firstTurn, ...laterTurns].entries()) {
    const hit = () => { them -= turn.damage ?? 0; if (turn.toxic) them -= foe.maxHp * (t + 1) / 16; };
    if (turn.incoming) { mine -= theirs; continue; }        // switching in: take the hit, no attack
    if (weFirst) { hit(); if (them <= 0) break; mine -= theirs; if (mine <= 0) break; }
    else { mine -= theirs; if (mine <= 0) break; hit(); if (them <= 0) break; }
  }
  const foeLost = Math.min(foe.hp, foe.hp - Math.max(0, them)) / foe.maxHp;
  const weLost = Math.min(ourHp, ourHp - Math.max(0, mine)) / us.maxHp;
  return foeLost - weLost + (them <= 0 ? 1 : 0) - (mine <= 0 ? 0.6 : 0);
}

export class SearchBrain extends GreedyBrain {
  async chooseAction(battle, options) {
    const { you, foe, field } = battle;
    const best = bestAttack(you, foe, field);
    const bestHit = best ? best.avg : 0;
    return this.pick(options, (o) => {
      if (o.kind === 'switch') {
        const b = bestAttack(o.mon, foe, field);
        return playOut({ us: o.mon, foe, field, firstTurn: { incoming: true }, laterTurns: [{ damage: b ? b.avg : 0 }] }) - 0.05;
      }
      if (o.fails) return -2;
      const move = MOVE_DATA.get(o.moveId);
      const acc = (move.accuracy || 100) / 100;
      const hit = o.est && !o.est.unknown ? ((o.est.min + o.est.max) / 2) * acc : 0;
      const first = { damage: hit, priority: move.priority, toxic: move.effect === 'TOXIC' && !(foe.status1 & 0xFF) };
      const boost = SELF_BOOSTS[move.effect];
      const next = move.effect === 'RECHARGE' ? { damage: 0 }
        : boost ? { damage: (bestAttack(withStages(you, boost), foe, field)?.avg ?? 0) }
        : { damage: Math.max(hit, bestHit) };
      if (/Use Protect|Use Detect/.test(o.text)) return -0.5;
      // Same downsides the models are told about: a recharge turn (RED's next
      // Pokémon or this one gets a free hit), misses, recoil, scarce PP.
      const cost = (o.downsides ?? []).reduce((sum, d) => sum + (d === 'a recharge turn' ? 0.3 : /accuracy/.test(d) ? 1 - acc : 0.05), 0);
      return playOut({ us: you, foe, field, firstTurn: first, laterTurns: [next] }) - cost;
    });
  }
  async chooseSendIn(battle, options) {
    const { foe, field } = battle;
    return this.pick(options, (o) => {
      const b = bestAttack(o.mon, foe, field);
      return playOut({ us: o.mon, foe, field, firstTurn: { damage: b ? b.avg : 0 }, laterTurns: [{ damage: b ? b.avg : 0 }] });
    });
  }
}

// --- State sent to Jev ---------------------------------------------------------------------------------
let stateStyle = 'full';
export function setStateStyle(style) { stateStyle = style; }
// Lean: only what the decision needs most (the two active Pokémon, the threat,
// notes and field); drops roles, recent actions and the other Pokémon.
export function leanState(state) {
  const { your_roles, your_recent_actions, red_other_pokemon, your_fainted_pokemon, ...rest } = state;
  return { ...rest, your_other_pokemon: (state.your_other_pokemon ?? []).length };
}
export function turnState(battle) {
  const full = fullTurnState(battle);
  return stateStyle === 'lean' ? leanState(full) : full;
}
// For each of RED's Pokémon still standing: your best answer to it right now
// (current HP, PP and status), from the same one-on-one simulation as the
// options. The same for every option, so it lives in the state: it shows when
// a choice would spend the only answer to a later fight.
// A Pokémon's best plan against `r`: attacking right away, or one setup move
// (a stat boost or Toxic) first, whichever wins more often.
function bestPlan(m, r, field) {
  let best = { p: exchange(m, r, field)?.pWin ?? 0, setup: null };
  m.moves.forEach((id, i) => {
    if (!id || (m.pp && m.pp[i] <= 0)) return;
    const move = MOVE_DATA.get(id);
    if (!(SELF_BOOSTS[move.effect] && move.effect !== 'CURSE') && move.effect !== 'TOXIC') return;
    if (move.effect === 'TOXIC' && failureReason(id, m, r)) return;
    const p = exchange(m, r, field, m.hp, [id])?.pWin ?? 0;
    if (p > best.p + 0.05) best = { p, setup: move.name };
  });
  return best;
}

function threatBoard(battle) {
  const { you, foe, bench, foeTeam, field } = battle;
  const ours = [you, ...bench].filter((m) => m.hp > 0);
  const reds = (foeTeam ?? []).map((m) => (m.active ? foe : m)).filter((m) => m.hp > 0);
  return reds.map((r) => {
    const ranked = ours.map((m) => ({ m, ...bestPlan(m, r, field) })).sort((a, b) => b.p - a.p);
    const [best, next] = ranked;
    const how = (x) => (x.setup ? `, with ${x.setup} first` : '');
    const label = `${r.speciesName} (HP ${pct(r.hp, r.maxHp)}%${r === foe ? ', in battle now' : ''})`;
    if (!best || best.p < 0.5) return `${label}: none of your Pokémon wins a one-on-one${best ? ` (best: ${best.m.speciesName}, about ${pctOf(best.p)}%)` : ''}`;
    return `${label}: best answer ${best.m.speciesName} (wins about ${pctOf(best.p)}%${how(best)})${next && next.p >= 0.5 ? `; also ${next.m.speciesName} (${pctOf(next.p)}%${how(next)})` : '; the only one that wins'}`;
  });
}

function fullTurnState(battle) {
  const { you, foe, bench, foeTeam, fainted, field, history = [] } = battle;
  const notes = [];
  if (!canStillDamage(you, foe, field)) {
    notes.push(`${you.speciesName} has no damaging moves left against ${foe.speciesName}: switch to a Pokémon that can take the hit (a tank for the others), or use a status move that helps.`);
  }
  const heals = foe.moves.filter((id, i) => id && foe.pp[i] && HEALING_EFFECTS.has(MOVE_DATA.get(id).effect)).map((id) => MOVE_DATA.get(id).name);
  if (heals.length) notes.push(`${foe.speciesName} can heal with ${heals.join(' and ')}, so slow damage gets undone: damage it quickly.`);
  if (isFiller(battle.roles, you)) {
    notes.push(`${you.speciesName} is filler: it is fine for it to be knocked out if that lets a better Pokémon come in for free afterwards.`);
  }
  if (battle.noAnswerTo === foe.speciesName) {
    notes.push(`None of your Pokémon is a good answer to ${foe.speciesName}. Wear it down with one Pokémon rather than switching between several: each switch gives it a free attack.`);
  }
  const weather = Object.entries(field.weather).filter(([, on]) => on).map(([w]) => w);
  const sideText = (s) => Object.entries(s).filter(([, on]) => on).map(([k]) => pretty(k.replace(/([A-Z])/g, '_$1').toUpperCase())).join(', ') || 'none';
  return {
    turn: battle.turn,
    your_active_pokemon: { ...describeMon(you, { side: 'you' }), speed: `${effectiveSpeed(you, field.weather)} (${foe.speciesName}: ${effectiveSpeed(foe, field.weather)})` },
    red_active_pokemon: describeMon(foe, { side: 'foe' }),
    red_threat_to_you: threatWords(foe, you, field),
    your_other_pokemon: bench.map((m) => `${m.speciesName} (${typesText(m.types)}, HP ${pct(m.hp, m.maxHp)}%, ${statusText(m.status1)})`),
    your_fainted_pokemon: fainted.map((m) => m.speciesName),
    red_other_pokemon: foeTeam.filter((m) => !m.active).map((m) => `${m.speciesName} (${typesText(m.types)}, ${m.hp ? `HP ${pct(m.hp, m.maxHp)}%` : 'fainted'})`),
    red_threats: threatBoard(battle),
    field: { weather: weather.join(', ') || 'clear', your_side: sideText(field.playerSide), red_side: sideText(field.foeSide) },
    your_recent_actions: history.slice(-3).map((h) => h.text),
    ...(battle.roles ? { your_roles: [you, ...bench].map((m) => roleText(battle.roles, m)) } : {}),
    ...(notes.length ? { notes } : {}),
  };
}

export function leadState(party, redTeam) {
  return {
    your_team: party.map((m) => ({ pokemon: m.speciesName, types: typesText(m.types), item: itemName(m.item), ability: abilityName(m.ability), moves: m.moves.filter(Boolean).map((id) => MOVE_DATA.get(id).name).join(', ') })),
    red_team: redTeam.map((m) => ({ pokemon: m.speciesName, types: typesText(m.types), item: itemName(m.item), moves: m.moves.map((id) => MOVE_DATA.get(id).name).join(', ') })),
  };
}
