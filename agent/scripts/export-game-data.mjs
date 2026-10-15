// Writes data/game-data.json from a Daily Red checkout's decomp source: the
// move, species, item, ability and type tables, the type chart and RED's
// party. Rerun after changing the ROM hack (moves, species or RED's team).
//
//   node scripts/export-game-data.mjs     (from agent/, with pokefirered/ fetched)
import { mkdirSync, writeFileSync } from 'node:fs';
import { GAME_DIR, requireDailyRed } from '../dailyred.mjs';
import { parseGameSource } from '../data.mjs';

requireDailyRed('Exporting game data');
const data = parseGameSource(GAME_DIR);
const out = new URL('../data/game-data.json', import.meta.url);
mkdirSync(new URL('.', out), { recursive: true });
writeFileSync(out, `${JSON.stringify(data)}\n`);
console.log(`${data.moveData.length} moves, ${data.speciesData.length} species, ${data.chart.length} type pairs, RED: ${data.redParty.length} Pokémon -> data/game-data.json`);
