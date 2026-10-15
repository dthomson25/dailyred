// Gen 3 damage estimates (the formula in CalculateBaseDamage, battle_util.c /
// pokemon.c), so the arithmetic stays in code and Jev only sees the results.
// Covers stat stages, STAB, type chart, held items, burn, screens, weather and
// the abilities that change damage most. Critical hits are ignored.
import {
  MOVE_DATA, ABILITIES, ITEMS, TYPES, effectiveness, isPhysicalType, hiddenPower,
  FIXED_DAMAGE_EFFECTS,
} from './data.mjs';

const A = (name) => ABILITIES.byName.get(name);
const I = (name) => ITEMS.byName.get(name);
const T = (name) => TYPES.byName.get(name);

// Stat stage index in BattlePokemon.statStages (6 = neutral).
export const STAGE = { ATK: 1, DEF: 2, SPEED: 3, SPATK: 4, SPDEF: 5, ACC: 6, EVASION: 7 };
const stageMul = (stage) => (stage >= 6 ? (2 + stage - 6) / 2 : 2 / (2 + 6 - stage));

// Type-boosting held items (+10%), from the decomp's item names.
const TYPE_BOOSTERS = {
  SILK_SCARF: 'NORMAL', BLACK_BELT: 'FIGHTING', SHARP_BEAK: 'FLYING', POISON_BARB: 'POISON', SOFT_SAND: 'GROUND',
  HARD_STONE: 'ROCK', SILVER_POWDER: 'BUG', SPELL_TAG: 'GHOST', METAL_COAT: 'STEEL', CHARCOAL: 'FIRE',
  MYSTIC_WATER: 'WATER', MIRACLE_SEED: 'GRASS', MAGNET: 'ELECTRIC', TWISTED_SPOON: 'PSYCHIC', NEVER_MELT_ICE: 'ICE',
  DRAGON_FANG: 'DRAGON', BLACK_GLASSES: 'DARK', SEA_INCENSE: 'WATER',
};
const BOOSTER_TYPE = new Map(Object.entries(TYPE_BOOSTERS).map(([item, type]) => [I(item), T(type)]));

// The move's actual type and power for this attacker (Hidden Power, Return, etc.).
export function resolveMove(moveId, attacker, weather = {}) {
  const move = MOVE_DATA.get(moveId);
  let { type, power } = move;
  switch (move.effect) {
    case 'HIDDEN_POWER': ({ type, power } = hiddenPower(attacker.ivs)); break;
    case 'RETURN': power = Math.floor((10 * attacker.friendship) / 25); break;
    case 'FRUSTRATION': power = Math.floor((10 * (255 - attacker.friendship)) / 25); break;
    case 'ERUPTION': power = Math.max(1, Math.floor((150 * attacker.hp) / attacker.maxHp)); break;
    case 'FLAIL': case 'REVERSAL': {
      const scaled = Math.floor((48 * attacker.hp) / attacker.maxHp);
      power = scaled <= 1 ? 200 : scaled <= 4 ? 150 : scaled <= 9 ? 100 : scaled <= 16 ? 80 : scaled <= 32 ? 40 : 20;
      break;
    }
    case 'FACADE': if (attacker.status1 & 0xD8) power *= 2; break;
    case 'WEATHER_BALL':
      if (weather.rain) { type = T('WATER'); power = 100; }
      else if (weather.sun) { type = T('FIRE'); power = 100; }
      else if (weather.sandstorm) { type = T('ROCK'); power = 100; }
      else if (weather.hail) { type = T('ICE'); power = 100; }
      break;
    case 'LOW_KICK': power = 60; break;       // depends on weight; use a middling value
    case 'MAGNITUDE': power = 71; break;      // average
    case 'SPIT_UP': power = 0; break;
    default: break;
  }
  return { ...move, type, power };
}

const hits = (effect) => (effect === 'DOUBLE_HIT' || effect === 'TWINEEDLE' ? 2 : effect === 'MULTI_HIT' ? 3 : effect === 'TRIPLE_KICK' ? 3 : 1);

// Estimated damage of one move. Returns null for status moves, otherwise
// { min, max } in HP, plus { effectiveness }, or { fixed: true } for fixed-damage moves.
export function estimateDamage(moveId, attacker, defender, field = {}) {
  const weather = field.weather ?? {};
  const move = resolveMove(moveId, attacker, weather);
  if (FIXED_DAMAGE_EFFECTS.has(move.effect)) {
    const fixed = {
      LEVEL_DAMAGE: attacker.level, DRAGON_RAGE: 40, SONICBOOM: 20, SUPER_FANG: Math.max(1, Math.floor(defender.hp / 2)),
      PSYWAVE: attacker.level, ENDEAVOR: Math.max(0, defender.hp - attacker.hp),
    }[move.effect];
    const eff = effectiveness(move.type, defender.types);
    if (eff === 0 && move.effect !== 'ENDEAVOR' && move.effect !== 'SUPER_FANG') return { min: 0, max: 0, effectiveness: 0, fixed: true };
    if (fixed === undefined) return { fixed: true, effectiveness: eff, min: 0, max: 0, unknown: true };
    return { min: Math.min(fixed, defender.hp), max: Math.min(fixed, defender.hp), effectiveness: eff, fixed: true };
  }
  if (!move.power) return null;

  // Immunities from abilities.
  const dAbility = defender.ability;
  const immune = (dAbility === A('LEVITATE') && move.type === T('GROUND'))
    || (dAbility === A('FLASH_FIRE') && move.type === T('FIRE'))
    || (dAbility === A('WATER_ABSORB') && move.type === T('WATER'))
    || (dAbility === A('VOLT_ABSORB') && move.type === T('ELECTRIC'));
  let eff = effectiveness(move.type, defender.types);
  if (dAbility === A('WONDER_GUARD') && eff <= 1) eff = 0;
  if (immune) eff = 0;
  if (eff === 0) return { min: 0, max: 0, effectiveness: 0 };

  const physical = isPhysicalType(move.type);
  let atk = physical ? attacker.stats.atk : attacker.stats.spa;
  let def = physical ? defender.stats.def : defender.stats.spd;
  let power = move.power;

  // Attacker items and abilities.
  if (physical && attacker.item === I('CHOICE_BAND')) atk = Math.floor(atk * 1.5);
  if (!physical && attacker.item === I('LIGHT_BALL') && attacker.speciesName === 'Pikachu') atk *= 2;
  if (physical && attacker.item === I('THICK_CLUB') && ['Cubone', 'Marowak'].includes(attacker.speciesName)) atk *= 2;
  if (physical && [A('HUGE_POWER'), A('PURE_POWER')].includes(attacker.ability)) atk *= 2;
  if (physical && attacker.ability === A('HUSTLE')) atk = Math.floor(atk * 1.5);
  if (physical && attacker.ability === A('GUTS') && (attacker.status1 & 0xFF)) atk = Math.floor(atk * 1.5);
  if (BOOSTER_TYPE.get(attacker.item) === move.type) power = Math.floor(power * 1.1);
  if (dAbility === A('THICK_FAT') && (move.type === T('FIRE') || move.type === T('ICE'))) power = Math.floor(power / 2);
  if (attacker.hp <= Math.floor(attacker.maxHp / 3)) {
    const pinch = { OVERGROW: 'GRASS', BLAZE: 'FIRE', TORRENT: 'WATER', SWARM: 'BUG' };
    for (const [ability, type] of Object.entries(pinch)) {
      if (attacker.ability === A(ability) && move.type === T(type)) power = Math.floor(power * 1.5);
    }
  }
  if (physical && dAbility === A('MARVEL_SCALE') && (defender.status1 & 0xFF)) def = Math.floor(def * 1.5);
  if (move.effect === 'EXPLOSION') def = Math.floor(def / 2);

  // Stat stages.
  atk = Math.floor(atk * stageMul(attacker.stages[physical ? STAGE.ATK : STAGE.SPATK]));
  def = Math.max(1, Math.floor(def * stageMul(defender.stages[physical ? STAGE.DEF : STAGE.SPDEF])));

  let base = Math.floor(Math.floor((Math.floor((2 * attacker.level) / 5) + 2) * power * atk / def) / 50);
  if (physical && (attacker.status1 & 0x10) && attacker.ability !== A('GUTS')) base = Math.floor(base / 2);
  const screens = field.defenderScreens ?? {};
  if (physical && screens.reflect && move.effect !== 'BRICK_BREAK') base = Math.floor(base / 2);
  if (!physical && screens.lightScreen) base = Math.floor(base / 2);
  if (weather.rain && move.type === T('WATER')) base = Math.floor(base * 1.5);
  if (weather.rain && move.type === T('FIRE')) base = Math.floor(base / 2);
  if (weather.sun && move.type === T('FIRE')) base = Math.floor(base * 1.5);
  if (weather.sun && move.type === T('WATER')) base = Math.floor(base / 2);
  if (move.effect === 'SOLAR_BEAM' && (weather.rain || weather.sandstorm || weather.hail)) base = Math.floor(base / 2);
  if (attacker.flashFire && move.type === T('FIRE')) base = Math.floor(base * 1.5);
  base += 2;

  if (attacker.types.includes(move.type)) base = Math.floor(base * 1.5);
  base = Math.floor(base * eff);
  const n = hits(move.effect);
  return {
    min: Math.max(1, Math.floor((base * 85) / 100)) * n,
    max: base * n,
    effectiveness: eff,
  };
}

// Effective speed in battle: stage, weather abilities and paralysis.
export function effectiveSpeed(mon, weather = {}) {
  let speed = Math.floor(mon.stats.spe * stageMul(mon.stages[STAGE.SPEED]));
  if (mon.ability === A('SWIFT_SWIM') && weather.rain) speed *= 2;
  if (mon.ability === A('CHLOROPHYLL') && weather.sun) speed *= 2;
  if (mon.status1 & 0x40) speed = Math.floor(speed / 4);
  return speed;
}
