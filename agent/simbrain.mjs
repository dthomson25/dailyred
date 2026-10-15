// A no-model player built only on the world model (play.mjs --policy sim):
// every option is scored with the same simulations the option text quotes,
// and the best score wins. Shows how far the computed facts go on their own,
// and so how much a judgment model adds on top of them.
//
//   move     win chance of the one-on-one if this move is used now and the
//            best attacks after it (a setup move counts as a setup plan)
//   switch   the incoming Pokémon's win chance after taking the entry hit,
//            minus a small cost for the free hit
//   send-in  that Pokémon's best plan against RED's Pokémon
//   lead     win chance against RED's lead minus the later win chance it
//            would spend (the lead cost)
//   roles    the best one-on-one for each RED Pokémon (as the greedy baseline)
import { GreedyBrain, exchange, bestPlan, leadScore } from './brain.mjs';
import { predictRedMove } from './redai.mjs';
import { estimateDamage } from './damage.mjs';
import { MOVE_DATA } from './data.mjs';

// Expected damage of RED's likely move (chosen against `you`) on the incoming Pokémon.
function entryDamage(foe, you, incoming, field) {
  return predictRedMove(foe, you, field).reduce((sum, { id, p }) => {
    const e = estimateDamage(id, foe, incoming, { weather: field.weather, defenderScreens: field.playerSide });
    return sum + (e && !e.unknown ? p * ((e.min + e.max) / 2) : 0);
  }, 0);
}

export class SimBrain extends GreedyBrain {
  async chooseAction(battle, options) {
    const { you, foe, field } = battle;
    return this.pick(options, (o) => {
      if (o.kind === 'switch') {
        // Entry hit from RED's most likely move against the Pokémon it sees now (as the option text).
        const hit = entryDamage(foe, you, o.mon, field);
        return (exchange(o.mon, foe, field, Math.max(1, o.mon.hp - hit))?.pWin ?? 0) - 0.05;
      }
      if (o.fails) return -1;
      const move = MOVE_DATA.get(o.moveId);
      if (!move.power || move.power <= 1) {
        // Status move: worth it only as a setup plan (boost, Toxic).
        const p = exchange(you, foe, field, you.hp, [o.moveId])?.pWin ?? 0;
        return p - 0.02;
      }
      // An attack: the one-on-one with this move first, then the best attacks.
      return (exchange(you, foe, field, you.hp, [], o.moveId)?.pWin ?? 0) + (o.koChance ?? 0) * 0.01;
    });
  }

  async chooseSendIn(battle, options) {
    const { foe, field } = battle;
    return this.pick(options, (o) => bestPlan(o.mon, foe, field).p);
  }

  async chooseLead(party, redTeam, options) {
    return this.pick(options, (o) => leadScore(o.mon, party, redTeam));
  }
}
