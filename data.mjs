// Game data for the agent: move data, species base stats and types,
// abilities, item names, the type chart and RED's party. It comes from the
// decomp's own source files, so it always matches the ROM. Those are parsed
// once into data/game-data.json (scripts/export-game-data.mjs), so the agent's
// decisions, tests and replays run without a Daily Red checkout; without the
// snapshot, the source is parsed directly from DAILYRED_DIR.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GAME_DIR } from './dailyred.mjs';

const SNAPSHOT = new URL('./data/game-data.json', import.meta.url);

// Everything read from the decomp, as plain JSON-friendly values.
export function parseGameSource(dir = GAME_DIR) {
  const read = (file) => readFileSync(join(dir, file), 'utf8');
  const defines = (file, prefix) => {
    const byName = {};
    for (const m of read(file).matchAll(new RegExp(`^#define ${prefix}(\\w+)\\s+(\\d+)\\b`, 'gm'))) {
      if (!(m[1] in byName)) byName[m[1]] = Number(m[2]);
    }
    return byName;
  };
  const types = defines('include/constants/pokemon.h', 'TYPE_');
  const species = defines('include/constants/species.h', 'SPECIES_');
  const moves = defines('include/constants/moves.h', 'MOVE_');
  const items = defines('include/constants/items.h', 'ITEM_');
  const abilities = defines('include/constants/abilities.h', 'ABILITY_');

  const moveData = [];
  for (const m of read('src/data/battle_moves.h').matchAll(/\[MOVE_(\w+)\]\s*=\s*\{([^}]*)\}/g)) {
    const body = m[2];
    const field = (f) => body.match(new RegExp(`\\.${f} = (-?\\w+)`))?.[1];
    moveData.push([moves[m[1]], {
      name: pretty(m[1]),
      effect: field('effect')?.replace(/^EFFECT_/, ''),
      power: Number(field('power') ?? 0),
      type: types[field('type')?.replace(/^TYPE_/, '')],
      accuracy: Number(field('accuracy') ?? 0),
      chance: Number(field('secondaryEffectChance') ?? 0),
      priority: Number(field('priority') ?? 0),
      contact: /FLAG_MAKES_CONTACT/.test(body),
    }]);
  }

  const speciesData = [];
  for (const chunk of read('src/data/pokemon/species_info.h').split('[SPECIES_').slice(1)) {
    const id = species[chunk.split(']')[0]];
    const num = (f) => Number(chunk.match(new RegExp(`\\.${f}\\s*=\\s*(\\d+)`))?.[1]);
    const t = chunk.match(/\.types\s*=\s*\{\s*TYPE_(\w+),\s*TYPE_(\w+)/);
    const a = chunk.match(/\.abilities\s*=\s*\{\s*ABILITY_(\w+),\s*ABILITY_(\w+)/);
    if (id === undefined || !t) continue;
    // genderRatio: MON_MALE 0, MON_FEMALE 254, MON_GENDERLESS 255, or PERCENT_FEMALE(x) = min(254, x*255/100).
    const g = chunk.match(/\.genderRatio\s*=\s*(MON_\w+|PERCENT_FEMALE\(([\d.]+)\))/);
    const genderRatio = !g ? 127 : g[1] === 'MON_MALE' ? 0 : g[1] === 'MON_FEMALE' ? 254 : g[1] === 'MON_GENDERLESS' ? 255
      : Math.min(254, Math.floor((Number(g[2]) * 255) / 100));
    speciesData.push([id, {
      genderRatio,
      base: ['baseHP', 'baseAttack', 'baseDefense', 'baseSpeed', 'baseSpAttack', 'baseSpDefense'].map(num),
      types: [types[t[1]], types[t[2]]],
      abilities: a ? [abilities[a[1]], abilities[a[2]]] : [0, 0],
    }]);
  }

  // gTypeEffectiveness in battle_main.c. Multipliers x10: 0 (immune), 5, 20.
  // Pairs not listed are 10. Entries after TYPE_FORESIGHT are the Ghost
  // immunities that Foresight removes.
  const chart = [];
  const table = read('src/battle_main.c').match(/gTypeEffectiveness\[\d+\] =\s*\{([\s\S]*?)\};/)[1];
  const mul = { TYPE_MUL_NO_EFFECT: 0, TYPE_MUL_NOT_EFFECTIVE: 5, TYPE_MUL_SUPER_EFFECTIVE: 20, TYPE_MUL_NORMAL: 10 };
  for (const m of table.matchAll(/TYPE_(\w+),\s*TYPE_(\w+),\s*(TYPE_MUL_\w+)/g)) chart.push([`${types[m[1]]}:${types[m[2]]}`, mul[m[3]]]);

  // RED's party and EVs, from the Daily Red boss file (src/dailyred_boss.c).
  const boss = read('src/dailyred_boss.c');
  const evRows = [...boss.match(/gDailyRedBossEVs[^=]*=\s*\{([\s\S]*?)\};/)[1].matchAll(/\{([^}]*)\}/g)].map((m) => m[1].split(',').map(Number));
  const redParty = [...boss.matchAll(/\.species = SPECIES_(\w+),\s*\.heldItem = ITEM_(\w+),\s*\.moves = \{([^}]*)\}/g)].map((m, i) => ({
    species: species[m[1]], item: items[m[2]],
    moves: m[3].split(',').map((x) => moves[x.trim().replace(/^MOVE_/, '')]),
    evs: evRows[i],
  }));

  return { types, species, moves, items, abilities, moveData, speciesData, chart, redParty };
}

const RAW = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : parseGameSource();
const table = (byNameObj) => {
  const byName = new Map(Object.entries(byNameObj));
  const byId = new Map();
  for (const [name, id] of byName) if (!byId.has(id)) byId.set(id, name);
  return { byName, byId };
};

// "THUNDER_WAVE" -> "Thunder Wave"
export function pretty(name) { return (name ?? '?').toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' '); }

export const TYPES = table(RAW.types);
export const SPECIES = table(RAW.species);
export const MOVES = table(RAW.moves);
export const ITEMS = table(RAW.items);
export const ABILITIES = table(RAW.abilities);
export const RED_PARTY = RAW.redParty;

export const typeName = (id) => pretty(TYPES.byId.get(id));
export const speciesName = (id) => pretty(SPECIES.byId.get(id));
export const moveName = (id) => pretty(MOVES.byId.get(id));
export const itemName = (id) => (id ? pretty(ITEMS.byId.get(id)) : 'none');
export const abilityName = (id) => pretty(ABILITIES.byId.get(id));

// In Gen 3 a move's type decides whether it is physical or special.
export const isPhysicalType = (type) => type < TYPES.byName.get('MYSTERY');

export const MOVE_DATA = new Map(RAW.moveData);
export const SPECIES_DATA = new Map(RAW.speciesData);
const CHART = new Map(RAW.chart);

// A Pokémon's gender, as GetGenderFromSpeciesAndPersonality in pokemon.c.
export function genderOf(species, personality) {
  const ratio = SPECIES_DATA.get(species)?.genderRatio ?? 127;
  if (ratio === 255) return 'genderless';
  if (ratio === 0) return 'male';
  if (ratio === 254) return 'female';
  return ratio > (personality & 0xFF) ? 'female' : 'male';
}

// Combined multiplier of an attacking type against a defender's one or two types.
export function effectiveness(moveType, defTypes) {
  let total = 1;
  for (const t of new Set(defTypes)) total *= (CHART.get(`${moveType}:${t}`) ?? 10) / 10;
  return total;
}

export function effectivenessWord(mult) {
  if (mult === 0) return 'no effect (immune)';
  if (mult >= 4) return 'super effective x4';
  if (mult >= 2) return 'super effective x2';
  if (mult <= 0.25) return 'not very effective x0.25';
  if (mult < 1) return 'not very effective x0.5';
  return 'normal effectiveness';
}

// --- Hidden Power (Gen 3): type and power from the IVs -------------------------------
const HP_TYPES = ['FIGHTING', 'FLYING', 'POISON', 'GROUND', 'ROCK', 'BUG', 'GHOST', 'STEEL',
  'FIRE', 'WATER', 'GRASS', 'ELECTRIC', 'PSYCHIC', 'ICE', 'DRAGON', 'DARK'];
export function hiddenPower(ivs) { // ivs: HP Atk Def Spe SpA SpD
  const bits = (n) => ivs.reduce((sum, iv, i) => sum + (((iv >> n) & 1) << i), 0);
  return {
    type: TYPES.byName.get(HP_TYPES[Math.floor((bits(0) * 15) / 63)]),
    power: Math.floor((bits(1) * 40) / 63) + 30,
  };
}

// --- Plain-language move effects -------------------------------------------------------
// Short descriptions for the effects that matter most when choosing a move.
// Anything not listed falls back to the effect's own name.
const EFFECT_TEXT = {
  HIT: 'just deals damage',
  SLEEP: 'puts the target to sleep',
  POISON: 'poisons the target', TOXIC: 'badly poisons the target (damage grows every turn)',
  PARALYZE: 'paralyzes the target (quarter speed, 25% chance to lose each turn)',
  WILL_O_WISP: 'burns the target (halves its physical damage)',
  CONFUSE: 'confuses the target', SWAGGER: 'confuses the target but raises its Attack by 2',
  FLATTER: 'confuses the target but raises its Sp. Atk by 1',
  ATTRACT: 'infatuates a target of the opposite gender',
  ATTACK_UP: 'raises your Attack by 1', ATTACK_UP_2: 'raises your Attack by 2',
  DEFENSE_UP: 'raises your Defense by 1', DEFENSE_UP_2: 'raises your Defense by 2',
  SPEED_UP_2: 'raises your Speed by 2', SPECIAL_ATTACK_UP: 'raises your Sp. Atk by 1',
  SPECIAL_ATTACK_UP_2: 'raises your Sp. Atk by 2', SPECIAL_DEFENSE_UP_2: 'raises your Sp. Def by 2',
  EVASION_UP: 'raises your evasion by 1', DEFENSE_CURL: 'raises your Defense by 1',
  MINIMIZE: 'raises your evasion by 1', BULK_UP: 'raises your Attack and Defense by 1',
  CALM_MIND: 'raises your Sp. Atk and Sp. Def by 1', DRAGON_DANCE: 'raises your Attack and Speed by 1',
  COSMIC_POWER: 'raises your Defense and Sp. Def by 1', CURSE: 'raises Attack and Defense by 1 but lowers Speed by 1 (Ghost types: cut own HP in half to curse the target)',
  BELLY_DRUM: 'cuts your HP in half to maximize Attack',
  ATTACK_DOWN: "lowers the target's Attack by 1", ATTACK_DOWN_2: "lowers the target's Attack by 2",
  DEFENSE_DOWN: "lowers the target's Defense by 1", DEFENSE_DOWN_2: "lowers the target's Defense by 2",
  SPEED_DOWN: "lowers the target's Speed by 1", SPEED_DOWN_2: "lowers the target's Speed by 2",
  SPECIAL_DEFENSE_DOWN_2: "lowers the target's Sp. Def by 2", ACCURACY_DOWN: "lowers the target's accuracy by 1",
  EVASION_DOWN: "lowers the target's evasion by 1", TICKLE: "lowers the target's Attack and Defense by 1",
  RESTORE_HP: 'restores half of your max HP', SOFTBOILED: 'restores half of your max HP',
  MORNING_SUN: 'restores HP (half, more in sun, less in other weather)', MOONLIGHT: 'restores HP (half, more in sun)',
  SYNTHESIS: 'restores HP (half, more in sun)', REST: 'fully heals you but you sleep for 2 turns',
  WISH: 'restores half your max HP at the end of next turn',
  PROTECT: 'protects you from attacks this turn (fails more often if used in a row)', ENDURE: 'you survive this turn with at least 1 HP',
  SUBSTITUTE: 'spends a quarter of your HP to make a substitute that takes hits', LEECH_SEED: 'drains 1/8 of the target\'s HP each turn to you',
  REFLECT: 'halves physical damage to your side for 5 turns', LIGHT_SCREEN: 'halves special damage to your side for 5 turns',
  SAFEGUARD: 'protects your side from status for 5 turns', MIST: 'prevents stat drops on your side',
  SPIKES: "damages the foe's Pokémon when they switch in", HAZE: 'resets all stat changes on both sides',
  RAIN_DANCE: 'starts rain for 5 turns (Water x1.5, Fire x0.5)', SUNNY_DAY: 'starts sun for 5 turns (Fire x1.5, Water x0.5)',
  SANDSTORM: 'starts a sandstorm for 5 turns', HAIL: 'starts hail for 5 turns',
  ROAR: 'forces the foe to switch to a random Pokémon', WHIRLWIND: 'forces the foe to switch to a random Pokémon',
  BATON_PASS: 'switches out and passes stat changes to the next Pokémon',
  TAUNT: 'stops the target from using status moves for 2 turns', ENCORE: 'forces the target to repeat its last move',
  DISABLE: "disables the target's last move", TORMENT: 'stops the target using the same move twice in a row',
  PERISH_SONG: 'every Pokémon on the field faints in 3 turns unless it switches',
  DESTINY_BOND: 'if you faint before your next move, the attacker faints too',
  MEAN_LOOK: 'stops the target from switching', SPLASH: 'does nothing', TELEPORT: 'does nothing in a trainer battle',
  TRANSFORM: 'turns into a copy of the target', METRONOME: 'uses a random move', MIMIC: "copies the target's last move",
  SKETCH: "permanently copies the target's last move", PAIN_SPLIT: "averages your HP and the target's HP",
  RECOVER: 'restores half of your max HP',
  OHKO: 'knocks out the target in one hit if it lands (30% accuracy, fails on higher-level targets)',
  LEVEL_DAMAGE: 'deals damage equal to your level (100 HP)', DRAGON_RAGE: 'always deals 40 HP of damage',
  SONICBOOM: 'always deals 20 HP of damage', SUPER_FANG: "cuts the target's HP in half",
  PSYWAVE: 'deals 50-150 HP of damage at level 100', ENDEAVOR: "cuts the target's HP down to yours",
  COUNTER: 'returns double the physical damage you took this turn (moves last)',
  MIRROR_COAT: 'returns double the special damage you took this turn (moves last)',
  EXPLOSION: 'huge damage, but you faint', RECHARGE: 'strong hit, but you must rest next turn',
  RECOIL: 'you take a quarter of the damage dealt as recoil', DOUBLE_EDGE: 'you take a third of the damage dealt as recoil',
  ABSORB: 'you recover half the damage dealt', DREAM_EATER: 'only works on a sleeping target; you recover half the damage dealt',
  RAZOR_WIND: 'charges on the first turn, hits on the second', SKY_ATTACK: 'charges on the first turn, hits on the second',
  SOLAR_BEAM: 'charges on the first turn (instant in sun), hits on the second', SKULL_BASH: 'charges on the first turn, hits on the second',
  SEMI_INVULNERABLE: 'two-turn move: dodges most attacks on the first turn, hits on the second',
  QUICK_ATTACK: 'always moves first', MACH_PUNCH: 'always moves first', FAKE_OUT: 'only works on your first turn out; makes the target flinch and moves first',
  FOCUS_PUNCH: 'moves last and fails if you are hit first', RAPID_SPIN: 'removes Spikes and binding moves from your side',
  THIEF: "steals the target's held item", KNOCK_OFF: "knocks off the target's held item",
  FALSE_SWIPE: 'leaves the target with at least 1 HP', RAMPAGE: 'attacks for 2-3 turns, then you become confused',
  ROLLOUT: 'hits for 5 turns with doubling power', FURY_CUTTER: 'power doubles with each hit in a row',
  MULTI_HIT: 'hits 2-5 times', DOUBLE_HIT: 'hits twice', TRIPLE_KICK: 'hits up to 3 times with rising power',
  TRAP: 'traps and damages the target for 2-5 turns', BIDE: 'waits 2 turns, then returns double the damage taken',
  FOCUS_ENERGY: 'raises your critical-hit ratio', SPIT_UP: 'power depends on Stockpile', STOCKPILE: 'stores power for Spit Up',
  SWALLOW: 'heals depending on Stockpile', NIGHTMARE: 'damages a sleeping target each turn',
  YAWN: 'the target falls asleep at the end of next turn', FUTURE_SIGHT: 'hits 2 turns later',
  MAGIC_COAT: 'reflects status moves back at the user', SNATCH: "steals the target's next self-boosting move",
  IMPRISON: 'stops the foe using moves you also know', GRUDGE: 'if you faint, the move that knocked you out loses all PP',
  CHARGE: 'doubles your next Electric move', HELPING_HAND: 'no effect in a single battle', FOLLOW_ME: 'no effect in a single battle',
  RECYCLE: 'restores a used berry', REFRESH: 'cures your burn, poison or paralysis', HEAL_BELL: "cures your whole team's status",
  INGRAIN: 'restores 1/16 HP each turn but you cannot switch', AQUA_RING: 'restores HP each turn',
  MUD_SPORT: 'weakens Electric moves', WATER_SPORT: 'weakens Fire moves', CAMOUFLAGE: 'changes your type',
  CONVERSION: 'changes your type to one of your moves', CONVERSION_2: 'changes your type to resist the last move that hit you',
  LOCK_ON: 'your next move cannot miss', FORESIGHT: 'lets Normal and Fighting moves hit Ghost types', ODOR_SLEUTH: 'lets Normal and Fighting moves hit Ghost types',
  SPITE: "cuts the PP of the target's last move", MEMENTO: "you faint, sharply lowering the target's Attack and Sp. Atk",
  SKILL_SWAP: 'swaps abilities with the target', ROLE_PLAY: "copies the target's ability", PSYCH_UP: "copies the target's stat changes",
  SECRET_POWER: 'may cause a side effect', ASSIST: 'uses a random move from your team', SLEEP_TALK: 'uses a random move while asleep',
  SNORE: 'only works while asleep', NATURE_POWER: 'becomes Swift here', MIRROR_MOVE: "copies the target's last move",
  RAGE: 'Attack rises when hit', PURSUIT: 'double power if the target switches out',
  FLAIL: 'stronger the lower your HP', REVERSAL: 'stronger the lower your HP', ERUPTION: 'weaker the lower your HP',
  RETURN: 'power from friendship', FRUSTRATION: 'power from low friendship', HIDDEN_POWER: 'type and power depend on IVs',
  LOW_KICK: "power depends on the target's weight", PRESENT: 'random power, may heal the target', MAGNITUDE: 'random power',
  FACADE: 'double power if you are burned, poisoned or paralyzed', SMELLINGSALT: 'double power on a paralyzed target (cures it)',
  REVENGE: 'double power if you were hit first this turn', WEATHER_BALL: 'type and power change with the weather',
  BRICK_BREAK: 'breaks Reflect and Light Screen', OVERHEAT: "lowers your Sp. Atk by 2 after hitting", SUPERPOWER: 'lowers your Attack and Defense after hitting',
  VITAL_THROW: 'moves last but never misses', ALWAYS_HIT: 'never misses', THUNDER: 'may paralyze; never misses in rain', BLIZZARD: 'may freeze',
  HURRICANE: 'may confuse', TWISTER: 'may flinch', GUST: 'hits Pokémon in the air',
  BURN_HIT: 'may burn', FREEZE_HIT: 'may freeze', PARALYZE_HIT: 'may paralyze', POISON_HIT: 'may poison', FLINCH_HIT: 'may make the target flinch',
  CONFUSE_HIT: 'may confuse', TRI_ATTACK: 'may burn, freeze or paralyze', HIGH_CRITICAL: 'high critical-hit ratio',
  POISON_FANG: 'may badly poison', BLAZE_KICK: 'may burn; high critical-hit ratio', POISON_TAIL: 'may poison; high critical-hit ratio',
  THAW_HIT: 'may burn; thaws you out', SECRET_POWER_HIT: 'may cause a side effect',
  ATTACK_DOWN_HIT: "may lower the target's Attack", DEFENSE_DOWN_HIT: "may lower the target's Defense",
  SPEED_DOWN_HIT: "lowers the target's Speed", SPECIAL_ATTACK_DOWN_HIT: "may lower the target's Sp. Atk",
  SPECIAL_DEFENSE_DOWN_HIT: "may lower the target's Sp. Def", ACCURACY_DOWN_HIT: "may lower the target's accuracy",
  DEFENSE_UP_HIT: 'may raise your Defense', ATTACK_UP_HIT: 'may raise your Attack', ALL_STATS_UP_HIT: 'may raise all your stats',
  EARTHQUAKE: 'just deals damage', SURF: 'just deals damage', TWINEEDLE: 'hits twice, may poison', DOUBLE_EDGE_HIT: 'recoil',
  STOMP: 'may flinch; double power on a Minimized target', SPLASH_HIT: 'just deals damage',
};
export function effectText(move) {
  return EFFECT_TEXT[move.effect] ?? pretty(move.effect).toLowerCase();
}

// Moves whose damage the plain formula doesn't describe; described in words instead.
export const FIXED_DAMAGE_EFFECTS = new Set(['LEVEL_DAMAGE', 'DRAGON_RAGE', 'SONICBOOM', 'SUPER_FANG', 'PSYWAVE', 'ENDEAVOR', 'OHKO', 'COUNTER', 'MIRROR_COAT', 'BIDE', 'PRESENT']);
