// Where the Daily Red checkout is: the ROM hack this agent plays. Live play
// (play.mjs, battle.mjs and the batch runners) drives its emulator, reads its
// RAM through the symbol map of the built ROM, and walks to RED on its map;
// export-game-data.mjs reads its decomp source. Everything else (option text,
// RED's AI, simulations, decision tests, replays) runs from data/game-data.json
// and needs no checkout.
//
// The agent lives in agent/ of a Daily Red fork, so by default that is the
// repo around it; set DAILYRED_DIR to use another checkout.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DAILYRED_DIR = resolve(process.env.DAILYRED_DIR || join(HERE, '..'));
export const GAME_DIR = join(DAILYRED_DIR, 'pokefirered');

export function requireDailyRed(what) {
  if (!existsSync(join(DAILYRED_DIR, 'tests', 'lib.mjs'))) {
    throw new Error(`${what} needs a Daily Red checkout (with the ROM built): set DAILYRED_DIR (looked in ${DAILYRED_DIR}).`);
  }
}

// Daily Red's own modules, loaded from the checkout.
export const loadDailyRed = (path) => { requireDailyRed(path); return import(pathToFileURL(join(DAILYRED_DIR, path)).href); };
