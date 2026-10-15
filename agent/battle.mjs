// Reads the battle from game RAM and drives the battle menus with button
// presses, using the helpers the tests already have for the emulator.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDailyRed } from './dailyred.mjs';
// Live play only: Daily Red's test helpers (emulator, RAM, buttons) and party decoder.
const { ROOT, ELF, GAME_DIR, readMemory, symbol, press, sleep } = await loadDailyRed('tests/lib.mjs');
const { decodeMon } = await loadDailyRed('tests/party.mjs');
import { SPECIES_DATA, speciesName } from './data.mjs';

// --- Addresses -----------------------------------------------------------------------
// Several battle controllers have a static function with the same name
// (HandleInputChooseAction, ...); keep the one inside the player controller.
function playerControllerSymbol(name) {
  const nm = join(ROOT, '.toolchain/arm-none-eabi/bin/arm-none-eabi-nm');
  const out = execFileSync(existsSync(nm) ? nm : 'arm-none-eabi-nm', [ELF], { encoding: 'utf8', maxBuffer: 64 << 20 });
  const map = readFileSync(join(GAME_DIR, 'pokefirered_modern.map'), 'utf8');
  const m = map.match(/\.text\s+0x([0-9a-f]+)\s+0x([0-9a-f]+) src\/battle_controller_player\.o/);
  const start = parseInt(m[1], 16), end = start + parseInt(m[2], 16);
  for (const line of out.split('\n')) {
    const [addr, , sym] = line.trim().split(/\s+/);
    const a = parseInt(addr, 16);
    if (sym === name && a >= start && a < end) return a;
  }
  throw new Error(`${name} not found in the player battle controller`);
}

const ADDR = {
  chooseAction: playerControllerSymbol('HandleInputChooseAction'),
  chooseMove: symbol('HandleInputChooseMove'),
  chooseMonTask: symbol('Task_HandleChooseMonInput'),
  partyMenuCB2: symbol('CB2_UpdatePartyMenu'),
  battleCB2: symbol('BattleMainCB2'),
  overworldCB2: symbol('CB2_Overworld'),
};

const MON_SIZE = 100;
const BMON_SIZE = 0x58;
const DISABLE_SIZE = 0x1C;                // sizeof(struct DisableStruct)
const BATTLE_STRUCT_CHOICED_MOVE = 200;   // offsetof(struct BattleStruct, choicedMove)

// --- Reading the battle -------------------------------------------------------------------
const abilityOf = (species, abilityNum) => {
  const [a, b] = SPECIES_DATA.get(species).abilities;
  return abilityNum && b ? b : a;
};

// The in-battle copy of an active Pokémon (struct BattlePokemon).
function readBattleMon(mem, battler) {
  const b = mem.read(symbol('gBattleMons') + battler * BMON_SIZE, BMON_SIZE);
  const ivWord = b.readUInt32LE(0x14);
  const species = b.readUInt16LE(0);
  return {
    species,
    speciesName: speciesName(species),
    level: b[0x2A],
    hp: b.readUInt16LE(0x28),
    maxHp: b.readUInt16LE(0x2C),
    stats: { atk: b.readUInt16LE(2), def: b.readUInt16LE(4), spe: b.readUInt16LE(6), spa: b.readUInt16LE(8), spd: b.readUInt16LE(0xA) },
    moves: [0, 1, 2, 3].map((i) => b.readUInt16LE(0xC + i * 2)),
    pp: [...b.subarray(0x24, 0x28)],
    ivs: [0, 5, 10, 15, 20, 25].map((s) => (ivWord >>> s) & 31),
    stages: [...b.subarray(0x18, 0x20)].map((s) => (s << 24) >> 24),
    ability: b[0x20],
    types: [b[0x21], b[0x22]],
    friendship: b[0x2B],
    item: b.readUInt16LE(0x2E),
    personality: b.readUInt32LE(0x48),
    status1: b.readUInt32LE(0x4C),
    status2: b.readUInt32LE(0x50),
  };
}

// A party Pokémon (struct Pokemon) in the same shape, for the bench.
function readPartyMon(mem, side, slot) {
  const raw = mem.read(symbol(`g${side}Party`) + slot * MON_SIZE, MON_SIZE);
  const mon = decodeMon(raw);
  if (!mon) return null;
  // Garbage while the game is moving party data around (e.g. reordering it
  // after a switch): report it so the caller can read again.
  if (!SPECIES_DATA.has(mon.species)) return { unreadable: true };
  const buf = Buffer.from(raw);
  const [, atk, def, spe, spa, spd] = mon.stats;
  return {
    slot,
    species: mon.species,
    speciesName: speciesName(mon.species),
    level: mon.level,
    hp: mon.hp,
    maxHp: mon.maxHp,
    stats: { atk, def, spe, spa, spd },
    moves: mon.moves,
    pp: mon.pp,
    ivs: mon.ivs,
    stages: [6, 6, 6, 6, 6, 6, 6, 6],
    ability: abilityOf(mon.species, mon.abilityNum),
    types: SPECIES_DATA.get(mon.species).types,
    friendship: friendshipOf(buf),
    item: mon.heldItem,
    personality: buf.readUInt32LE(0),
    status1: buf.readUInt32LE(80),
    status2: 0,
  };
}

// Friendship lives in the encrypted Growth substructure (byte 9).
const ORDERS = ['GAEM', 'GAME', 'GEAM', 'GEMA', 'GMAE', 'GMEA', 'AGEM', 'AGME', 'AEGM', 'AEMG', 'AMGE', 'AMEG',
  'EGAM', 'EGMA', 'EAGM', 'EAMG', 'EMGA', 'EMAG', 'MGAE', 'MGEA', 'MAGE', 'MAEG', 'MEGA', 'MEAG'];
function friendshipOf(buf) {
  const personality = buf.readUInt32LE(0);
  const key = (personality ^ buf.readUInt32LE(4)) >>> 0;
  const at = 32 + ORDERS[personality % 24].indexOf('G') * 12 + 8;
  return ((buf.readUInt32LE(at) ^ key) >>> 8) & 0xFF;
}

function readField(mem) {
  const w = mem.read(symbol('gBattleWeather'), 2).readUInt16LE(0);
  const sides = mem.read(symbol('gSideStatuses'), 4);
  const side = (n) => {
    const s = sides.readUInt16LE(n * 2);
    return { reflect: !!(s & 1), lightScreen: !!(s & 2), spikes: !!(s & 0x10), safeguard: !!(s & 0x20), mist: !!(s & 0x100) };
  };
  return {
    weather: { rain: !!(w & 0x7), sandstorm: !!(w & 0x18), sun: !!(w & 0x60), hail: !!(w & 0x80) },
    playerSide: side(0),
    foeSide: side(1),
  };
}

// Everything the agent needs about the current battle.
export function readBattle(mem) {
  const partyIndexes = mem.read(symbol('gBattlerPartyIndexes'), 4);
  const foeSlot = partyIndexes.readUInt16LE(2);
  const you = readBattleMon(mem, 0);
  const foe = readBattleMon(mem, 1);
  const disable = (battler) => mem.read(symbol('gDisableStructs') + battler * DISABLE_SIZE, DISABLE_SIZE);
  const d0 = disable(0);
  const battleStruct = mem.read(symbol('gBattleStruct'), 4).readUInt32LE(0);
  const lastMoves = mem.read(symbol('gLastMoves'), 8);
  const statuses3 = mem.read(symbol('gStatuses3'), 8);
  you.disabledMove = d0.readUInt16LE(4);
  you.tauntTurns = d0[0x13] & 0xF;
  you.encoredMove = d0.readUInt16LE(6);
  you.choicedMove = mem.read(battleStruct + BATTLE_STRUCT_CHOICED_MOVE, 2).readUInt16LE(0);
  you.lastMove = lastMoves.readUInt16LE(0);
  you.substituteHp = d0[0xA];
  you.protectUses = d0[8];         // consecutive Protect/Endure uses
  you.leechSeeded = !!(statuses3.readUInt32LE(0) & 4);
  // Perish Song: the timer drops at the end of each turn and the Pokémon
  // faints when a turn ends with it already at 0 (battle_util.c).
  // null = not under Perish Song; otherwise the end-of-turn count it faints at.
  const perish = (battler, d) => ((statuses3.readUInt32LE(battler * 4) & 0x20) ? d[0xF] & 0xF : null);
  you.perishCount = perish(0, d0);
  foe.substituteHp = disable(1)[0xA];
  foe.leechSeeded = !!(statuses3.readUInt32LE(4) & 4);
  foe.perishCount = perish(1, disable(1));
  foe.lastMove = lastMoves.readUInt16LE(2);

  const bench = [];
  for (let slot = 0; slot < 6; slot++) {
    const mon = readPartyMon(mem, 'Player', slot);
    if (mon && mon.hp > 0 && mon.personality !== you.personality) bench.push(mon);
  }
  const foeTeam = [];
  for (let slot = 0; slot < 6; slot++) {
    const mon = readPartyMon(mem, 'Enemy', slot);
    if (mon) foeTeam.push({ ...mon, active: slot === foeSlot });
  }
  const fainted = [];
  for (let slot = 0; slot < 6; slot++) {
    const mon = readPartyMon(mem, 'Player', slot);
    if (mon && mon.hp === 0 && mon.personality !== you.personality) fainted.push(mon);
  }
  const unreadable = [...bench, ...foeTeam, ...fainted].some((m) => m.unreadable) || !SPECIES_DATA.has(you.species) || !SPECIES_DATA.has(foe.species);
  return {
    unreadable,
    turn: mem.read(symbol('gBattleResults') + 0x13, 1)[0] + 1,
    you, foe, bench, foeTeam, fainted,
    field: readField(mem),
  };
}

// Our whole party in party order (outside battle).
export function readOwnParty(mem) {
  const party = [];
  for (let slot = 0; slot < 6; slot++) party.push(readPartyMon(mem, 'Player', slot));
  return party.map((m) => (m && !m.unreadable ? m : null));
}

// RED's whole party (only filled in once the battle has started).
export function readFoeParty(mem) {
  const party = [];
  for (let slot = 0; slot < 6; slot++) party.push(readPartyMon(mem, 'Enemy', slot));
  return party.filter((m) => m && !m.unreadable);
}

// --- What the game is waiting for ------------------------------------------------------------
export async function readPhase(page) {
  const mem = await readMemory(page);
  const cb2 = mem.read(symbol('gMain') + 4, 4).readUInt32LE(0) & ~1;
  const ctrl = mem.read(symbol('gBattlerControllerFuncs'), 4).readUInt32LE(0) & ~1;
  const outcome = mem.read(symbol('gBattleOutcome'), 1)[0];
  // struct Task is 0x28 bytes: func, isActive, ... (16 tasks in gTasks).
  const tasks = mem.read(symbol('gTasks'), 16 * 0x28);
  let choosingMon = false;
  for (let i = 0; i < 16; i++) {
    if (tasks[i * 0x28 + 4] && (tasks.readUInt32LE(i * 0x28) & ~1) === ADDR.chooseMonTask) choosingMon = true;
  }
  let phase = 'busy';
  if (cb2 === ADDR.overworldCB2) phase = 'overworld';
  else if (outcome) phase = 'over';
  else if (cb2 === ADDR.partyMenuCB2) phase = choosingMon ? 'party' : 'busy';
  else if (cb2 === ADDR.battleCB2 && ctrl === ADDR.chooseAction) phase = 'action';
  else if (cb2 === ADDR.battleCB2 && ctrl === ADDR.chooseMove) phase = 'move';
  return {
    phase,
    mem,
    inPartyMenu: cb2 === ADDR.partyMenuCB2,
    outcome, // 1 = won, 2 = lost
    turn: mem.read(symbol('gBattleResults') + 0x13, 1)[0],
    actionCursor: mem.read(symbol('gActionSelectionCursor'), 1)[0],
    moveCursor: mem.read(symbol('gMoveSelectionCursor'), 1)[0],
    partySlot: (mem.read(symbol('gPartyMenu') + 9, 1)[0] << 24) >> 24,
  };
}

// Waits until the game wants input (or the battle is over). Some messages
// ("X fainted!") wait for A, so A is pressed now and then, re-checking just
// before each press that no menu has opened in the meantime.
export async function waitForInput(page, { timeoutMs = 180000 } = {}) {
  const end = Date.now() + timeoutMs;
  let lastPress = Date.now();
  const ready = (s) => ['action', 'party', 'over', 'overworld', 'move'].includes(s.phase);
  while (Date.now() < end) {
    const s = await readPhase(page);
    if (ready(s)) return s;
    if (Date.now() - lastPress > 2000) {
      const again = await readPhase(page);
      if (ready(again)) return again;
      if (again.phase === 'busy' && !again.inPartyMenu) await press(page, 'a');
      lastPress = Date.now();
    }
    await sleep(300);
  }
  throw new Error('timed out waiting for the battle to ask for input');
}

async function waitPhase(page, phases, timeoutMs = 8000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await readPhase(page);
    if (phases.includes(s.phase)) return s;
    await sleep(150);
  }
  return readPhase(page);
}

// Moves the 2x2 action cursor (0 FIGHT, 1 BAG, 2 POKéMON, 3 RUN) to `target`.
async function moveActionCursor(page, target) {
  for (let i = 0; i < 6; i++) {
    const { actionCursor } = await readPhase(page);
    if (actionCursor === target) return;
    if ((actionCursor & 2) !== (target & 2)) await press(page, target & 2 ? 'down' : 'up');
    else await press(page, target & 1 ? 'right' : 'left');
    await sleep(150);
  }
  throw new Error(`could not move the action cursor to ${target}`);
}

async function moveMoveCursor(page, target) {
  for (let i = 0; i < 6; i++) {
    const { moveCursor } = await readPhase(page);
    if (moveCursor === target) return;
    if ((moveCursor & 2) !== (target & 2)) await press(page, target & 2 ? 'down' : 'up');
    else await press(page, target & 1 ? 'right' : 'left');
    await sleep(150);
  }
  throw new Error(`could not move the move cursor to ${target}`);
}

// Uses the move in slot `index` (0-3). Returns true if the game accepted it,
// false if it refused (Disable, Taunt, Choice lock, no PP...).
export async function useMove(page, index) {
  const start = await readPhase(page);
  await moveActionCursor(page, 0);
  await press(page, 'a');
  const s = await waitPhase(page, ['move']);
  if (s.phase !== 'move') return s.turn !== start.turn || s.phase !== 'action'; // e.g. Struggle / locked move: no menu
  // A direction press can register a moment after the cursor was read, so
  // check the cursor is still on the move after a short pause before pressing A.
  for (let i = 0; i < 3; i++) {
    await moveMoveCursor(page, index);
    await sleep(200);
    if ((await readPhase(page)).moveCursor === index) break;
  }
  await press(page, 'a');
  // A refused move prints a message and returns to a menu without the turn advancing.
  await sleep(2500);
  const after = await readPhase(page);
  if ((after.phase === 'move' || after.phase === 'action') && after.turn === start.turn) {
    if (after.phase === 'move') { await press(page, 'b'); await waitPhase(page, ['action']); }
    return false;
  }
  return true;
}

// Picks the party member with this personality in the open party menu, then SHIFT.
async function pickInPartyMenu(page, personality) {
  for (let i = 0; i < 10; i++) {
    const s = await readPhase(page);
    const slot = readOwnParty(s.mem).findIndex((m) => m?.personality === personality);
    if (slot < 0) throw new Error('switch target not found in the party');
    if (s.partySlot === slot) break;
    await press(page, 'down');
    await sleep(200);
    if (i === 9) throw new Error('could not reach the party slot');
  }
  await press(page, 'a');      // opens SHIFT / SUMMARY / CANCEL
  await sleep(700);
  await press(page, 'a');      // SHIFT
  await sleep(1000);
}

// Switches to the bench Pokémon with this personality from the action menu.
// Returns false if the game refused (trapped).
export async function switchTo(page, personality) {
  const start = await readPhase(page);
  await moveActionCursor(page, 2);
  await press(page, 'a');
  const s = await waitPhase(page, ['party']);
  if (s.phase !== 'party') return false;
  await pickInPartyMenu(page, personality);
  const after = await waitPhase(page, ['busy', 'action'], 4000);
  if (after.phase === 'party') { // refused: leave the menu
    await press(page, 'b'); await sleep(600); await press(page, 'b');
    await waitPhase(page, ['action']);
    return false;
  }
  return after.turn !== start.turn || after.phase !== 'action';
}

// Sends in a replacement after a faint (the party menu is already open).
export async function sendIn(page, personality) {
  await pickInPartyMenu(page, personality);
}
