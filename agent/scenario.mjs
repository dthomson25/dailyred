// Hand-built battle situations, without the emulator. The decision layer
// (brain.mjs) only needs a battle object like readBattle() returns, so tests
// can describe a position in a few lines and check the options and the
// model's answer directly.
//
//   const battle = makeBattle({
//     you: mon('Pinsir', { moves: ['Swords Dance', 'Secret Power', 'Protect', 'Brick Break'] }),
//     foe: red('Charizard', { hp: '3%' }),
//     bench: [mon('Blissey', { moves: ['Water Pulse'] })],
//   });
import { SPECIES, MOVES, ITEMS, ABILITIES, SPECIES_DATA, pretty } from './data.mjs';
import { redTeamFromSource } from './brain.mjs';

const id = (table, name, what) => {
  const key = name.toUpperCase().replace(/[ -]/g, '_').replace(/[^A-Z0-9_]/g, '');
  const value = table.byName.get(key);
  if (value === undefined) throw new Error(`unknown ${what}: ${name}`);
  return value;
};
const STAGE_INDEX = { atk: 1, def: 2, spe: 3, spa: 4, spd: 5, acc: 6, eva: 7 };
const STATUS = { none: 0, sleep: 2, poison: 0x8, burn: 0x10, freeze: 0x20, paralysis: 0x40, toxic: 0x80 };
let nextPersonality = 1;
// gender: 'male' or 'female' picks a personality that gives it (for species
// that can be either); otherwise personalities just count up.
const personalityFor = (gender) => (gender === 'male' ? 0x1000 + (nextPersonality++ << 8) + 0xFF
  : gender === 'female' ? (nextPersonality++ << 8) : nextPersonality++);

const stagesFrom = (changes) => {
  const st = [6, 6, 6, 6, 6, 6, 6, 6];
  for (const [k, d] of Object.entries(changes)) st[STAGE_INDEX[k]] += d;
  return st;
};
const hpFrom = (hp, maxHp) => (typeof hp === 'string' ? Math.max(1, Math.round((maxHp * parseFloat(hp)) / 100)) : hp ?? maxHp);

// One of your Pokémon at level 100 (IVs 31, 85 EVs in every stat, neutral nature).
// hp: a number of HP, or a percentage string like '40%'.
export function mon(name, { moves = [], pp, hp, item, ability, status = 'none', stages = {}, level = 100, evs = 85, friendship = 255, protectUses = 0, perishCount = null, gender } = {}) {
  const species = id(SPECIES, name, 'species');
  const data = SPECIES_DATA.get(species);
  const stat = (k) => Math.floor(((2 * data.base[k] + 31 + Math.floor(evs / 4)) * level) / 100) + 5;
  const maxHp = Math.floor(((2 * data.base[0] + 31 + Math.floor(evs / 4)) * level) / 100) + level + 10;
  const moveIds = moves.map((m) => id(MOVES, m, 'move'));
  return {
    species, speciesName: pretty(SPECIES.byId.get(species)), level, maxHp, hp: hpFrom(hp, maxHp),
    stats: { atk: stat(1), def: stat(2), spe: stat(3), spa: stat(4), spd: stat(5) },
    moves: [...moveIds, 0, 0, 0, 0].slice(0, 4),
    pp: pp ?? [...moveIds.map(() => 10), 0, 0, 0, 0].slice(0, 4),
    ivs: [31, 31, 31, 31, 31, 31], stages: stagesFrom(stages),
    ability: ability ? id(ABILITIES, ability, 'ability') : data.abilities[0],
    types: data.types, friendship,
    item: item ? id(ITEMS, item, 'item') : 0,
    personality: personalityFor(gender),
    status1: STATUS[status], status2: 0,
    protectUses, perishCount, disabledMove: 0, tauntTurns: 0, encoredMove: 0, choicedMove: 0, lastMove: 0, substituteHp: 0, leechSeeded: false,
  };
}

// One of RED's Pokémon, exactly as in src/dailyred_boss.c, with optional changes.
export function red(name, { hp, status = 'none', stages = {}, pp, perishCount = null, gender } = {}) {
  const base = redTeamFromSource().find((m) => m.speciesName.toLowerCase() === name.toLowerCase());
  if (!base) throw new Error(`RED has no ${name}`);
  return {
    ...base, stages: stagesFrom(stages), pp: pp ?? [10, 10, 10, 10], hp: hpFrom(hp, base.maxHp),
    personality: personalityFor(gender), status1: STATUS[status], status2: 0,
    protectUses: 0, perishCount, substituteHp: 0, leechSeeded: false, lastMove: 0,
  };
}

// A battle object in the shape brain.mjs expects. redRest: RED's other
// Pokémon, by name or as red(...) objects (default: the rest of his team).
// roles: { Machamp: { reservedFor: ['Snorlax'] }, Absol: { answerTo: ['Espeon'] } }.
export function makeBattle({ you, foe, bench = [], redRest, fainted = [], turn = 5, weather = {}, playerSide = {}, foeSide = {}, roles, history = [], noAnswerTo = null }) {
  const rest = (redRest ?? redTeamFromSource().map((m) => m.speciesName).filter((n) => n !== foe.speciesName))
    .map((m) => (typeof m === 'string' ? red(m) : m));
  const byName = new Map([you, ...bench].map((m) => [m.speciesName, m]));
  return {
    turn, you, foe, bench, fainted, history, noAnswerTo,
    foeTeam: [{ ...foe, active: true }, ...rest.map((m) => ({ ...m, active: false }))],
    field: { weather, playerSide, foeSide },
    roles: roles ? new Map(Object.entries(roles).map(([name, r]) => [byName.get(name).personality, { reservedFor: r.reservedFor ?? [], answerTo: r.answerTo ?? [] }])) : undefined,
  };
}
