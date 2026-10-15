// RED's move choice, ported from FireRed's trainer AI for the flags his
// battle uses (AI_SCRIPT_CHECK_BAD_MOVE | AI_SCRIPT_TRY_TO_FAINT |
// AI_SCRIPT_CHECK_VIABILITY in the Daily Red patch). Every usable move starts
// at 100; each script adds or subtracts; RED uses the highest score, picking
// at random among ties. Only the rules his six Pokémon's moves can reach are
// ported (see data/battle_ai_scripts.s and src/battle_ai_script_commands.c).
//
// predictRedMove(red, you, field) -> [{ id, name, p }] sorted by probability,
// estimated by running the AI many times with its random rolls.
import { MOVE_DATA, TYPES, effectiveness, abilityName, typeName, isPhysicalType } from './data.mjs';

const TYPE_NAMES = TYPES.byId;
import { estimateDamage, effectiveSpeed } from './damage.mjs';

// Effects whose damage the AI leaves out when looking for its strongest move
// (sDiscouragedPowerfulMoveEffects).
const DISCOURAGED = new Set(['EXPLOSION', 'DREAM_EATER', 'RAZOR_WIND', 'SKY_ATTACK', 'RECHARGE', 'SKULL_BASH', 'SOLAR_BEAM',
  'SPIT_UP', 'FOCUS_PUNCH', 'SUPERPOWER', 'ERUPTION', 'OVERHEAT']);
// A fixed-seed generator, so the same position always gets the same
// prediction (option text stays identical across option orders and replays).
let seed = 1;
const random = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const rnd = (n) => random() * 256 < n; // if_random_less_than n
const hpPct = (m) => (100 * m.hp) / m.maxHp;
const stage = (m, i) => m.stages?.[i] ?? 6;

// The AI's damage (AI_CalcDmg: no critical hit, no accuracy) times its roll of 85-100%.
function aiDamage(id, red, you, field, roll) {
  const est = estimateDamage(id, red, you, { weather: field.weather, defenderScreens: field.playerSide });
  if (!est || est.unknown) return 0;
  return Math.max(1, Math.floor((est.max * roll) / 100));
}

function scoreOnce(red, you, field) {
  const moves = red.moves.map((id, i) => ({ id, i, move: id ? MOVE_DATA.get(id) : null }))
    .filter((m) => m.move && (red.pp?.[m.i] ?? 1) > 0 && red.disabledMove !== m.id);
  const rolls = moves.map(() => 100 - Math.floor(random() * 16));
  const dmg = moves.map((m, k) => (m.move.power > 1 ? aiDamage(m.id, red, you, field, rolls[k]) : 0));
  const strongest = Math.max(0, ...moves.map((m, k) => (DISCOURAGED.has(m.move.effect) ? 0 : dmg[k])));
  const youFaster = effectiveSpeed(you, field.weather) > effectiveSpeed(red, field.weather);
  const yourAbility = abilityName(you.ability);
  const yourStatus = you.status1 ?? 0;

  return moves.map((m, k) => {
    const { move } = m;
    let s = 100;
    const eff = move.power > 1 ? effectiveness(move.type, you.types) : 1;
    const type = typeName(move.type);

    // --- AI_CheckBadMove ---
    if (move.power > 1 && !DISCOURAGED.has(move.effect)) {
      if (eff === 0) s -= 10;
      else if (yourAbility === 'Volt Absorb' && type === 'Electric') s -= 12;
      else if (yourAbility === 'Water Absorb' && type === 'Water') s -= 12;
      else if (yourAbility === 'Flash Fire' && type === 'Fire') s -= 12;
      else if (yourAbility === 'Wonder Guard' && eff < 2) s -= 10;
      else if (yourAbility === 'Levitate' && type === 'Ground') s -= 10;
    }
    if (move.effect === 'RECHARGE' && eff === 0) s -= 10;
    if (move.effect === 'SLEEP' && (['Insomnia', 'Vital Spirit'].includes(yourAbility) || yourStatus)) s -= 10;
    if (move.effect === 'LEECH_SEED' && (you.leechSeeded || you.types.includes(TYPES.byName.get('GRASS')))) s -= 10;
    if (move.effect === 'CALM_MIND') { if (stage(red, 4) === 12) s -= 10; else if (stage(red, 5) === 12) s -= 8; }

    // --- AI_TryToFaint ---
    if (move.power > 1) {
      if (dmg[k] >= you.hp) s += move.effect === 'EXPLOSION' ? 0 : move.effect === 'QUICK_ATTACK' ? 6 : 4;
      else if (!DISCOURAGED.has(move.effect) && dmg[k] < strongest) s -= 1;
    }

    // --- AI_CheckViability ---
    const hp = hpPct(red);
    switch (move.effect) {
      case 'ABSORB': if (eff > 0 && eff <= 0.5 && !rnd(50)) s -= 3; break;
      case 'RECHARGE': {
        if (eff > 0 && eff <= 0.5) { s -= 1; break; }
        if (youFaster) { if (!(hp < 60)) s -= 1; } else if (hp > 40) s -= 1;
        break;
      }
      case 'REST': {
        let good;
        if (youFaster) good = hp < 60 || (!(hp > 70) && rnd(50));
        else if (hp === 100) { s -= 8; break; }
        else good = hp < 40 || (!(hp > 50) && rnd(70));
        if (!good) s -= 3; else if (!rnd(10)) s += 3;
        break;
      }
      case 'MORNING_SUN': case 'SYNTHESIS': case 'MOONLIGHT': case 'RESTORE_HP': case 'SOFTBOILED': {
        const w = field.weather ?? {};
        if (move.effect !== 'RESTORE_HP' && move.effect !== 'SOFTBOILED' && (w.rain || w.sandstorm || w.hail)) s -= 2;
        if (hp === 100) { s -= 3; break; }
        if (!youFaster) { s -= 8; break; }
        if (hp < 70 || rnd(30)) { if (!rnd(20)) s += 2; } else s -= 3;
        break;
      }
      case 'LEECH_SEED': case 'TOXIC': {
        if (!(hp > 50) && !rnd(50)) s -= 3;
        if (!(hpPct(you) > 50) && !rnd(50)) s -= 3;
        break;
      }
      case 'CALM_MIND': { // AI_CV_SpDefUp
        if (stage(red, 5) >= 9 && !rnd(100)) s -= 1;
        else if (stage(red, 5) < 9 && hp === 100 && !rnd(128)) s += 2;
        if (hp < 70 || !rnd(200)) {
          if (hp < 40) s -= 2;
          else {
            const last = you.lastMove ? MOVE_DATA.get(you.lastMove) : null;
            if (!last?.power) { if (!rnd(60)) s -= 2; }
            else if (isPhysicalType(last.type)) s -= 2;
            else if (!rnd(60) && !rnd(60)) s -= 2; // falls through AI_CV_SpDefUp5
          }
        }
        break;
      }
      case 'ALWAYS_HIT': {
        if (stage(you, 7) > 10 || stage(red, 6) < 2) s += 1;
        if (stage(you, 7) > 8 || stage(red, 6) < 4) { if (!rnd(100)) s += 1; }
        break;
      }
      default: break;
    }
    return { id: m.id, score: s };
  });
}

export function predictRedMove(red, you, field = {}, samples = 300) {
  field = { weather: {}, playerSide: {}, ...field };
  seed = 1;
  const counts = new Map();
  for (let n = 0; n < samples; n++) {
    const scored = scoreOnce(red, you, field);
    if (!scored.length) break;
    const top = Math.max(...scored.map((x) => x.score));
    const best = scored.filter((x) => x.score === top);
    for (const b of best) counts.set(b.id, (counts.get(b.id) ?? 0) + 1 / best.length);
  }
  return [...counts].map(([id, c]) => ({ id, name: MOVE_DATA.get(id).name, p: c / samples })).sort((a, b) => b.p - a.p);
}

// --- One-on-one, played out many times ---------------------------------------------------------
// Your Pokémon first uses the `setup` moves in order (stat boosts, Toxic),
// then the first of `ourMoveIds` it still has PP for (then the next, and so
// on); RED's AI only picks moves it has PP for; RED picks with its AI each turn
// (re-scored as HP changes). Damage rolls, accuracy, speed and priority,
// sleep (2-5 turns), paralysis (25% full paralysis, speed quartered), burn,
// poison, freeze, Leech Seed, Rest, Morning Sun, Giga Drain healing, recoil
// and recharge turns are simulated. Returns how often each side wins.
const SLP = 0x7, PSN = 0x8, BRN = 0x10, FRZ = 0x20, PAR = 0x40;
// Moves that spend a turn charging (Solar Beam not in sun; Fly, Dig and Dive
// dodge most attacks while charging).
export const isTwoTurn = (move, weather = {}) => ['RAZOR_WIND', 'SKULL_BASH', 'SKY_ATTACK', 'SEMI_INVULNERABLE'].includes(move?.effect)
  || (move?.effect === 'SOLAR_BEAM' && !weather.sun);
const RECOIL_SHARE = { RECOIL: 1 / 4, DOUBLE_EDGE: 1 / 3 };
// RED's stat-raising moves: stage changes by stat (1 Attack, 2 Defense,
// 4 Sp. Atk, 5 Sp. Def, as in damage.mjs STAGE).
const BOOSTS = {
  ATTACK_UP: { 1: 1 }, ATTACK_UP_2: { 1: 2 }, DEFENSE_UP: { 2: 1 }, DEFENSE_UP_2: { 2: 2 },
  SPECIAL_ATTACK_UP: { 4: 1 }, SPECIAL_ATTACK_UP_2: { 4: 2 }, SPECIAL_DEFENSE_UP_2: { 5: 2 },
  CALM_MIND: { 4: 1, 5: 1 }, BULK_UP: { 1: 1, 2: 1 }, DRAGON_DANCE: { 1: 1 }, COSMIC_POWER: { 2: 1, 5: 1 },
};
const stageMult = (st) => { const n = st - 6; return n >= 0 ? (2 + n) / 2 : 2 / (2 - n); };
// The same for your own setup moves (Swords Dance is ATTACK_UP_2, etc.); 3 = Speed.
const OUR_BOOSTS = { ...BOOSTS, SPEED_UP: { 3: 1 }, SPEED_UP_2: { 3: 2 }, DRAGON_DANCE: { 1: 1, 3: 1 } };
const TOX = 0x80;
export function simulateOneOnOne(mon, foe, field = {}, { ourMoveIds = [], ourMoveId, setup = [], startHp = mon.hp, runs = 200, maxTurns = 15 } = {}) {
  if (ourMoveId && !ourMoveIds.length) ourMoveIds = [ourMoveId];
  field = { weather: {}, playerSide: {}, foeSide: {}, ...field };
  let s = 7; // its own fixed-seed generator: the same position always gives the same numbers
  const r = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ours = ourMoveIds.map((id) => ({ id, slot: mon.moves.indexOf(id), move: MOVE_DATA.get(id),
    est: estimateDamage(id, mon, foe, { weather: field.weather, defenderScreens: field.foeSide }) }));
  const theirEst = new Map(foe.moves.filter(Boolean).map((id) => [id, estimateDamage(id, foe, mon, { weather: field.weather, defenderScreens: field.playerSide })]));
  const roll = (est) => (!est || est.unknown ? 0 : est.min + r() * (est.max - est.min));
  const spdMon = effectiveSpeed(mon, field.weather), spdFoe = effectiveSpeed(foe, field.weather);
  const cache = new Map();
  let redStages = [];
  const predict = (them, mine, myStatus, seeded, redPp) => {
    const out = redPp.map((p) => (p > 0 ? 1 : 0)).join('');
    const key = `${Math.round((20 * them) / foe.maxHp)}|${Math.round((20 * mine) / mon.maxHp)}|${myStatus ? 1 : 0}|${seeded ? 1 : 0}|${out}|${redStages.join('')}`;
    if (!cache.has(key)) cache.set(key, predictRedMove({ ...foe, hp: Math.max(1, Math.round(them)), pp: redPp, stages: redStages }, { ...mon, hp: Math.max(1, Math.round(mine)), status1: myStatus, leechSeeded: seeded }, field, 60));
    return cache.get(key);
  };
  const pick = (pred) => { let x = r(); for (const p of pred) { x -= p.p; if (x <= 0) return p.id; } return pred[pred.length - 1]?.id; };

  let wins = 0, losses = 0, winTurns = 0, winLeft = 0, loseDealt = 0, heals = 0;
  for (let run = 0; run < runs; run++) {
    let mine = startHp, them = foe.hp;
    let myStatus = mon.status1 & (SLP | PSN | BRN | FRZ | PAR) ? mon.status1 : 0, mySleep = myStatus & SLP;
    let theirSleep = foe.status1 & SLP, theirStatus = foe.status1 ?? 0;
    let seeded = !!mon.leechSeeded, myRecharge = false, theirRecharge = false, charging = false, outcome = null, turn = 0;
    const myPp = [...(mon.pp ?? [99, 99, 99, 99])], redPp = [...(foe.pp ?? [99, 99, 99, 99])];
    const start = foe.stages ?? [6, 6, 6, 6, 6, 6, 6, 6];
    redStages = [...start];
    // Damage scales with the stage change since the estimates were made.
    const boost = (stat) => stageMult(redStages[stat]) / stageMult(start[stat]);
    const myStart = mon.stages ?? [6, 6, 6, 6, 6, 6, 6, 6], myStages = [...myStart];
    const myBoost = (stat) => stageMult(myStages[stat]) / stageMult(myStart[stat]);
    let setupLeft = [...setup], toxicTurns = 0;
    for (turn = 1; turn <= maxTurns && !outcome; turn++) {
      const redMoveId = theirSleep || theirRecharge ? null : pick(predict(them, mine, myStatus, seeded, redPp));
      if (redMoveId) { const i = foe.moves.indexOf(redMoveId); if (i >= 0) redPp[i]--; }
      // Our move this turn: the charging one, else the best we still have PP for.
      const cur = ours.find((o) => o.slot < 0 || myPp[o.slot] > 0) ?? null;
      const ourMove = cur?.move ?? null, ourEst = cur?.est ?? null;
      const redMove = redMoveId ? MOVE_DATA.get(redMoveId) : null;
      const mySpd = (myStatus & PAR ? spdMon / 4 : spdMon) * myBoost(3), theirSpd = theirStatus & PAR ? spdFoe / 4 : spdFoe;
      const setupMove = setupLeft.length ? MOVE_DATA.get(setupLeft[0]) : null;
      const myPri = (setupMove ?? ourMove)?.priority ?? 0, theirPri = redMove?.priority ?? 0;
      const weFirst = myPri !== theirPri ? myPri > theirPri : mySpd !== theirSpd ? mySpd > theirSpd : r() < 0.5;
      const us = () => {
        if (myRecharge) { myRecharge = false; return; }
        if (mySleep) { mySleep--; if (mySleep) return; myStatus &= ~SLP; }
        if (myStatus & FRZ) { if (r() < 0.2) myStatus &= ~FRZ; else return; }
        if (myStatus & PAR && r() < 0.25) return;
        if (setupMove) {
          setupLeft.shift();
          const b = OUR_BOOSTS[setupMove.effect];
          if (b) for (const [st, n] of Object.entries(b)) myStages[st] = Math.min(12, myStages[st] + n);
          if (setupMove.effect === 'TOXIC' && !theirStatus && !foe.types.some((t) => ['POISON', 'STEEL'].includes(TYPE_NAMES.get(t)))
            && !(setupMove.accuracy && r() * 100 >= setupMove.accuracy)) { theirStatus = TOX; toxicTurns = 0; }
          return;
        }
        if (!ourMove) return;
        if (isTwoTurn(ourMove, field.weather) && !charging) { charging = true; return; }
        charging = false;
        if (cur.slot >= 0) myPp[cur.slot]--;
        if (ourMove.accuracy && r() * 100 >= ourMove.accuracy) return;
        const phys = ourMove.power && isPhysicalType(ourMove.type);
        let d = (roll(ourEst) * myBoost(phys ? 1 : 4)) / boost(phys ? 2 : 5);
        if (myStatus & BRN && ourMove.power && isPhysicalType(ourMove.type)) d /= 2;
        d = Math.min(d, Math.max(0, them));
        them -= d;
        if (RECOIL_SHARE[ourMove.effect]) mine -= d * RECOIL_SHARE[ourMove.effect];
        if (ourMove.effect === 'RECHARGE') myRecharge = true;
      };
      const red = () => {
        if (theirRecharge) { theirRecharge = false; return; }
        if (theirSleep) { theirSleep--; if (theirSleep) return; theirStatus &= ~SLP; }
        if (theirStatus & PAR && r() < 0.25) return;
        if (!redMove) return;
        const e = redMove.effect;
        if (e === 'REST') { if (them < foe.maxHp) { them = foe.maxHp; theirSleep = 3; theirStatus = SLP; heals++; } return; }
        if (['MORNING_SUN', 'SYNTHESIS', 'MOONLIGHT', 'RESTORE_HP', 'SOFTBOILED'].includes(e)) { them = Math.min(foe.maxHp, them + foe.maxHp / 2); heals++; return; }
        if (redMove.accuracy && e !== 'ALWAYS_HIT' && r() * 100 >= redMove.accuracy) return;
        if (e === 'SLEEP') { if (!myStatus) { mySleep = 2 + Math.floor(r() * 4); myStatus = mySleep; } return; }
        if (e === 'LEECH_SEED') { if (!mon.types.includes(TYPES.byName.get('GRASS'))) seeded = true; return; }
        if (BOOSTS[e]) { for (const [st, n] of Object.entries(BOOSTS[e])) redStages[st] = Math.min(12, redStages[st] + n); return; }
        if (!redMove.power) return;
        if (charging && ourMove?.effect === 'SEMI_INVULNERABLE' && e !== 'EARTHQUAKE') return; // Fly/Dig/Dive dodge it
        const theirPhys = isPhysicalType(redMove.type);
        const d = Math.min((roll(theirEst.get(redMoveId)) * boost(theirPhys ? 1 : 4)) / myBoost(theirPhys ? 2 : 5), Math.max(0, mine));
        mine -= d;
        if (e === 'ABSORB') them = Math.min(foe.maxHp, them + d / 2);
        if (RECOIL_SHARE[e]) them -= d * RECOIL_SHARE[e];
        if (e === 'RECHARGE') theirRecharge = true;
        if (!myStatus && redMove.chance && r() * 100 < redMove.chance) {
          if (e === 'PARALYZE_HIT') myStatus = PAR;
          else if (e === 'POISON_HIT') myStatus = PSN;
          else if (e === 'BURN_HIT') myStatus = BRN;
          else if (e === 'FREEZE_HIT') myStatus = FRZ;
        }
      };
      for (const act of weFirst ? [us, red] : [red, us]) {
        act();
        if (them <= 0) { outcome = 'win'; break; }
        if (mine <= 0) { outcome = 'lose'; break; }
      }
      if (outcome) break;
      // End of turn: poison and burn, then Leech Seed; RED's bad poison grows each turn.
      if (myStatus & (PSN | BRN)) mine -= mon.maxHp / 8;
      if (theirStatus & TOX) { toxicTurns++; them -= (foe.maxHp * Math.min(15, toxicTurns)) / 16; if (them <= 0) { outcome = 'win'; break; } }
      if (seeded) { const d = Math.min(mine, mon.maxHp / 8); mine -= d; them = Math.min(foe.maxHp, them + d); }
      if (mine <= 0) outcome = 'lose';
    }
    if (outcome === 'win') { wins++; winTurns += turn; winLeft += Math.max(0, mine) / mon.maxHp; }
    else if (outcome === 'lose') { losses++; loseDealt += Math.max(0, foe.hp - Math.max(0, them)) / foe.hp; }
  }
  return {
    pWin: wins / runs, pLose: losses / runs,
    winTurns: wins ? winTurns / wins : null, winLeft: wins ? winLeft / wins : null,
    loseDealt: losses ? loseDealt / losses : null, heals: heals / runs,
  };
}

// --- RED's next Pokémon ------------------------------------------------------------------------
// GetMostSuitableMonToSwitchInto (battle_ai_switch_items.c), used when RED's
// Pokémon faints or the AI switches: among his remaining Pokémon, the one
// your active Pokémon's types hit hardest (a single-type Pokémon's type counts
// twice, as in the game), provided it has a move super effective on you; if
// none qualifies, the one whose move does the most damage (kept to 0-255, as
// the game's u8 does). `reds` in party order; `exclude` = the one leaving.
export function predictRedSwitchIn(reds, you, field = {}, exclude = null) {
  field = { weather: {}, playerSide: {}, ...field };
  const [t1, t2 = t1] = you.types;
  const same = (a, b) => !!b && (a === b || (a.personality != null ? a.personality === b.personality : a.speciesName === b.speciesName));
  const candidates = reds.filter((m) => m.hp > 0 && !same(m, exclude));
  const invalid = new Set();
  while (invalid.size < candidates.length) {
    let best = null, bestDmg = 0;
    for (const m of candidates) {
      if (invalid.has(m)) continue;
      let d = 10;
      // Your two types (the same one twice for a single type) against its
      // types, a repeated defending type counted once.
      const defs = m.types[0] === m.types[1] || m.types.length === 1 ? [m.types[0]] : m.types;
      for (const atk of [t1, t2]) for (const def of defs) d = Math.floor((d * Math.round(effectiveness(atk, [def]) * 10)) / 10);
      if (bestDmg < d) { bestDmg = d; best = m; }
    }
    if (!best) break;
    if (best.moves.some((id) => id && MOVE_DATA.get(id).power > 1 && effectiveness(MOVE_DATA.get(id).type, you.types) > 1)) return best;
    invalid.add(best);
  }
  // Fallback, as the game does it: each candidate's moves, but with the stats
  // of the battler slot's current Pokémon (the one leaving), and the best
  // damage kept in a u8 (so it wraps above 255).
  const attackerOf = (m) => m;
  let best = null, bestDmg = 0;
  for (const m of candidates) for (const id of m.moves) {
    if (!id || MOVE_DATA.get(id).power === 1) continue;
    const est = estimateDamage(id, attackerOf(m), you, { weather: field.weather, defenderScreens: field.playerSide });
    const dmg = est && !est.unknown ? Math.floor(est.max) : 0;
    if (bestDmg < dmg) { bestDmg = dmg & 0xFF; best = m; }
  }
  return best;
}
