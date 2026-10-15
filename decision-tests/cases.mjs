// Decision test cases: hand-built situations with a known right answer.
//
// Each case has:
//   battle()   the situation (scenario.mjs helpers)
//   party()    for 'lead' cases instead: your six Pokémon (teams.json holds
//              real Daily Red teams, exactly as the game built them)
//   type       'action' (a turn), 'send_in' (after a faint) or 'lead'
//   prompt     checks on the option text the model will see (no model needed):
//              { option: key, contains: /regex/ } or { option: key, absent: true }
//   expect     the right decision: { pick: [keys] } (one of these) or { avoid: [keys] };
//              null = no known answer yet, prompt checks only. Lead answers
//              come from lead-sweep.mjs (measured), never from reasoning, and
//              from battles where the same model played the rest: a lead's value
//              depends on who plays after it.
//   why        the reasoning (or the measurement), for people reading a failure
//   filter     false = show flagged options (with their warnings) instead of
//              removing them, to test whether the model heeds the warning
//
// Option keys: move_1..move_4 (by move slot), switch_<Name>, send_<Name>, lead_<Name>.
import { readFileSync } from 'node:fs';
import { mon, red, makeBattle } from '../scenario.mjs';

const TEAMS = JSON.parse(readFileSync(new URL('./teams.json', import.meta.url), 'utf8'));
const team = (seed) => () => TEAMS[seed].map((m) => ({ ...m }));

export default [
  {
    name: 'attacks instead of switching when not in danger',
    why: 'Facade knocks Pikachu (80%) out for sure and Pikachu cannot knock Dragonite out first, so switching or setting up only gives RED free hits.',
    type: 'action',
    battle: () => makeBattle({
      you: mon('Dragonite', { moves: ['Thunderbolt', 'Thunder Wave', 'Dive', 'Facade'] }),
      foe: red('Pikachu', { hp: '80%' }),
      bench: [mon('Blissey', { moves: ['Water Pulse', 'Hyper Beam'] })],
    }),
    prompt: [
      { option: 'switch_Blissey', contains: /No benefit/ },
      { option: 'move_4', contains: /Knocks Pikachu out this turn \(guaranteed\)/ },
    ],
    expect: { pick: ['move_4'] },
  },
  {
    name: 'uses Toxic in a long fight it cannot lose',
    why: "Rock Smash needs about a dozen hits and Espeon can heal; Espeon barely scratches Tyranitar, so Toxic first knocks it out several turns sooner.",
    type: 'action',
    battle: () => makeBattle({
      you: mon('Tyranitar', { moves: ['Rain Dance', 'Toxic', 'Scary Face', 'Rock Smash'] }),
      foe: red('Espeon', { hp: '94%' }),
      bench: [mon('Wigglytuff', { moves: ['Brick Break', 'Body Slam'] })],
    }),
    prompt: [{ option: 'move_2', contains: /^Plan: Toxic first, then Rock Smash: Tyranitar wins this one-on-one about \d+% of the time[^.]*against \d+% attacking right away/ }],
    expect: { pick: ['move_2'] },
  },
  {
    name: 'avoids Hyper Beam when a plain attack also knocks out',
    why: 'Body Slam guarantees the knockout too; Hyper Beam can miss and its recharge turn gives RED\'s next Pokémon a free attack.',
    type: 'action',
    battle: () => makeBattle({
      you: mon('Snorlax', { moves: ['Hyper Beam', 'Body Slam', 'Rest', 'Curse'] }),
      foe: red('Pikachu', { hp: '40%' }),
      bench: [mon('Blissey', { moves: ['Water Pulse'] })],
    }),
    prompt: [
      { option: 'move_1', contains: /Overkill: Body Slam/ },
      { option: 'move_1', contains: /Recharge cost/ },
      { option: 'move_2', contains: /Knocks Pikachu out this turn \(guaranteed\)/ },
    ],
    expect: { pick: ['move_2'] },
  },
  {
    name: 'switches to a tank when attacking is wasted',
    why: 'Charizard (3%) is faster and knocks Pinsir out before it can attack; Blissey takes the hit and finishes Charizard next turn.',
    type: 'action',
    battle: () => makeBattle({
      you: mon('Pinsir', { moves: ['Swords Dance', 'Secret Power', 'Protect', 'Brick Break'] }),
      foe: red('Charizard', { hp: '3%' }),
      bench: [mon('Blissey', { moves: ['Water Pulse', 'Hyper Beam'] })],
    }),
    filter: false,
    prompt: [
      { option: 'move_2', contains: /Wasted:/ }, // Pinsir faints before it can attack
      { option: 'switch_Blissey', contains: /Benefit: saves Pinsir/ },
    ],
    expect: { pick: ['switch_Blissey'] },
  },
  {
    name: 'sends in a Pokémon that survives, not one that faints first',
    why: 'Bellsprout and Pinsir are slower than Charizard and faint to Flamethrower before attacking; Pelipper resists Fire and its Surf is super effective.',
    type: 'send_in',
    battle: () => makeBattle({
      you: mon('Masquerain', { hp: 0, moves: ['Hyper Beam'] }),
      foe: red('Charizard'),
      bench: [
        mon('Bellsprout', { moves: ['Giga Drain', 'Wrap'] }),
        mon('Pinsir', { moves: ['Secret Power', 'Brick Break'] }),
        mon('Pelipper', { moves: ['Surf', 'Ice Beam', 'Hydro Pump'] }),
      ],
    }),
    filter: false,
    prompt: [
      { option: 'send_Bellsprout', contains: /Faints before attacking/ },
      { option: 'send_Pelipper', contains: /Surf|Hydro Pump/ },
    ],
    expect: { pick: ['send_Pelipper'] },
  },
  {
    name: 'keeps a reserved Pokémon for its matchup',
    why: 'Machamp is reserved for Snorlax and Espeon\'s Psychic is super effective on it; Absol is the planned answer to Espeon (Dark: immune to Psychic).',
    type: 'send_in',
    battle: () => makeBattle({
      you: mon('Ariados', { hp: 0, moves: ['Night Shade'] }),
      foe: red('Espeon'),
      bench: [
        mon('Machamp', { moves: ['Brick Break', 'Seismic Toss', 'Fire Blast'] }),
        mon('Absol', { moves: ['Bite', 'Blizzard', 'Protect'] }),
      ],
      roles: { Machamp: { reservedFor: ['Snorlax'] }, Absol: { answerTo: ['Espeon'] } },
    }),
    filter: false,
    prompt: [{ option: 'send_Machamp', contains: /reserved as the answer to Snorlax/ }],
    expect: { pick: ['send_Absol'] },
  },
  {
    name: 'stalls with Protect when the foe is about to faint to Perish Song',
    why: 'Both sides are down to their last Pokémon. Snorlax cannot switch out and faints from Perish Song at the end of this turn; Absol (15%) would be knocked out by Snorlax first unless it protects. Protect is the only way to survive the turn, and surviving it wins. (With other Pokémon left, RED\'s AI would switch Snorlax out instead.)',
    type: 'action',
    battle: () => makeBattle({
      you: mon('Absol', { moves: ['Perish Song', 'Protect', 'Blizzard', 'Sunny Day'], hp: '15%', perishCount: 1 }),
      foe: red('Snorlax', { perishCount: 0 }),
      redRest: [],
    }),
    prompt: [
      { option: 'move_2', contains: /Stalling:/ },
      { option: 'move_3', contains: /Trade: Blizzard lands first, then Snorlax/ },
    ],
    expect: { pick: ['move_2'] },
  },
  {
    name: 'does not use a move that will fail',
    why: 'Snorlax is already paralyzed, so Thunder Wave fails; with a safe option available it is not offered at all.',
    type: 'action',
    battle: () => makeBattle({
      you: mon('Jolteon', { moves: ['Thunder Wave', 'Thunderbolt', 'Double Kick', 'Pin Missile'] }),
      foe: red('Snorlax', { status: 'paralysis' }),
    }),
    prompt: [{ option: 'move_1', absent: true }],
    expect: { avoid: ['move_1'] },
  },
  {
    name: 'saves a Pokémon about to be knocked out by switching to a resist',
    why: 'Venusaur (30%) faints to Charizard\'s Flamethrower; Blastoise resists Fire and threatens Charizard with Surf.',
    type: 'action',
    battle: () => makeBattle({
      you: mon('Venusaur', { moves: ['Giga Drain', 'Sludge Bomb', 'Sleep Powder', 'Leech Seed'], hp: '30%' }),
      foe: red('Charizard'),
      bench: [mon('Blastoise', { moves: ['Surf', 'Ice Beam', 'Earthquake'] })],
    }),
    filter: false,
    prompt: [
      { option: 'move_1', contains: /Wasted:/ },
      { option: 'switch_Blastoise', contains: /Benefit: saves Venusaur/ },
    ],
    expect: { pick: ['switch_Blastoise'] },
  },
  {
    name: 'uses a priority move to knock out a faster foe first',
    why: 'Charizard (8%) is faster and would knock Raticate out before Hyper Fang lands; Quick Attack moves first and finishes it.',
    type: 'action',
    filter: false,
    battle: () => makeBattle({
      you: mon('Raticate', { moves: ['Hyper Fang', 'Quick Attack', 'Super Fang', 'Scary Face'], hp: '60%' }),
      foe: red('Charizard', { hp: '8%' }),
      bench: [mon('Blissey', { moves: ['Water Pulse'] })],
    }),
    prompt: [
      { option: 'move_1', contains: /Wasted:/ },
      { option: 'move_2', contains: /Knocks Charizard out this turn \(guaranteed\)/ },
    ],
    expect: { pick: ['move_2'] },
  },
  {
    name: 'still uses the priority move when the stronger move would also knock out',
    why: 'Both knock Charizard (8%) out, but only Quick Attack lands before Charizard moves; Hyper Fang lets Charizard hit first.',
    type: 'action',
    battle: () => makeBattle({
      you: mon('Raticate', { moves: ['Hyper Fang', 'Quick Attack', 'Super Fang', 'Scary Face'] }),
      foe: red('Charizard', { hp: '8%' }),
    }),
    prompt: [{ option: 'move_2', contains: /Knocks Charizard out this turn \(guaranteed\)/ }],
    expect: { pick: ['move_2'] },
  },
  {
    name: 'does not use Attract on a Pokémon of the same gender',
    why: 'Attract fails when both Pokémon are the same gender; Body Slam does real damage.',
    type: 'action',
    filter: false,
    battle: () => makeBattle({
      you: mon('Wigglytuff', { moves: ['Attract', 'Body Slam', 'Sing', 'Protect'], gender: 'male' }),
      foe: red('Snorlax', { gender: 'male' }),
      bench: [mon('Machamp', { moves: ['Brick Break'] })],
    }),
    prompt: [{ option: 'move_1', contains: /Will fail: Snorlax is the same gender \(male\)/ }],
    expect: { avoid: ['move_1'] },
  },
  {
    name: 'counts only the attacks RED would really use',
    why: "RED's AI prefers Surf to Hydro Cannon (it marks recharge moves down), so Ariados is only at risk when Hydro Cannon is picked and rolls high: not labeled as fainting first.",
    type: 'send_in',
    battle: () => makeBattle({
      you: mon('Absol', { moves: ['Blizzard'], hp: 0 }),
      foe: red('Blastoise'),
      bench: [mon('Ariados', { moves: ['Hyper Beam', 'Sludge Bomb', 'String Shot', 'Spider Web'] }), mon('Machamp', { moves: ['Brick Break', 'Cross Chop'] })],
    }),
    prompt: [
      { option: 'send_Ariados', contains: /^Exchange: Blastoise wins this one-on-one/ },
      { option: 'send_Machamp', contains: /Exchange: Blastoise wins this one-on-one/ },
    ],
    expect: { avoid: [] },
  },
  {
    name: 'sends in the Pokémon that wins the one-on-one',
    why: "Absol's Dark attacks are super effective on Espeon and it is immune to Psychic, so it wins the exchange; Machamp is weak to Psychic and faints before it attacks.",
    type: 'send_in',
    filter: false,
    battle: () => makeBattle({
      you: mon('Pinsir', { moves: ['Brick Break'], hp: 0 }),
      foe: red('Espeon'),
      bench: [mon('Absol', { moves: ['Bite', 'Slash', 'Blizzard'] }), mon('Machamp', { moves: ['Brick Break', 'Rock Slide'] })],
    }),
    prompt: [
      { option: 'send_Absol', contains: /Exchange: Absol wins this one-on-one/ },
      { option: 'send_Machamp', contains: /Faints before attacking: Espeon is faster/ },
    ],
    expect: { pick: ['send_Absol'] },
  },
  {
    name: 'says plainly when a recharge turn costs all your HP',
    why: 'Charizard attacks twice before Ninetales can act again, which knocks it out; the text should say "100% or more", not "100-100%".',
    type: 'action',
    battle: () => makeBattle({
      you: mon('Ninetales', { moves: ['Hyper Beam', 'Flamethrower', 'Will-O-Wisp', 'Confuse Ray'] }),
      foe: red('Charizard'),
      bench: [mon('Blissey', { moves: ['Water Pulse'] })],
    }),
    prompt: [{ option: 'move_1', contains: /about (100% or more|\d+% to over 100%) of your HP in total/ }],
    expect: { avoid: ['move_1'] },
  },
  {
    name: 'does not promise a slow win against a Pokémon that heals',
    why: "Snorlax uses Rest when low (FireRed's AI) and hits back hard, so attackers that need 3+ hits lose; the exchange says so instead of claiming a win.",
    type: 'send_in',
    battle: () => makeBattle({
      you: mon('Ninetales', { moves: ['Facade'], hp: 0 }),
      foe: red('Snorlax', { hp: '89%' }),
      bench: [mon('Seadra', { moves: ['Hydro Pump', 'Surf'] }), mon('Venusaur', { moves: ['Solar Beam', 'Sludge Bomb'] })],
    }),
    prompt: [{ option: 'send_Seadra', contains: /Exchange: Snorlax wins this one-on-one about \d+% of the time/ }],
    expect: { avoid: [] },
  },
  {
    name: 'prefers a fast win over a bulky Pokémon that RED can put to sleep',
    why: "Venusaur's AI uses Sleep Powder, Leech Seed and Giga Drain: slow Scizor needs 4 hits and loses; Jynx's Ice Punch wins in about 2 turns. (Live, Scizor here cost Jev about 2 knockouts per battle.)",
    type: 'send_in',
    battle: () => makeBattle({
      you: mon('Dugtrio', { moves: ['Earthquake'], hp: 0 }),
      foe: red('Venusaur'),
      bench: [mon('Jynx', { moves: ['Ice Punch', 'Psychic', 'Lovely Kiss'] }), mon('Scizor', { moves: ['Slash', 'Steel Wing'] })],
    }),
    prompt: [
      { option: 'send_Jynx', contains: /Exchange: Jynx wins this one-on-one about \d+% of the time/ },
      { option: 'send_Scizor', contains: /Exchange: Venusaur wins this one-on-one about \d+% of the time/ },
    ],
    expect: { pick: ['send_Jynx'] },
  },
  // --- Leads on real teams. Expected answers are filled in from lead-sweep.mjs. ---
  {
    name: 'lead (team 1234): states the cost of spending the answer to Snorlax',
    why: 'Prompt checks only: the lead options must say which Pokémon are needed later and what leading costs.',
    type: 'lead',
    party: team('1234'),
    prompt: [
      { option: 'lead_Milotic', contains: /only Pokémon that beats [^.]*Charizard/ },
      { option: 'lead_Ariados', contains: /does not win a one-on-one against any of RED's other Pokémon/ },
      { option: 'lead_Machamp', contains: /Lead cost: [^.]*Snorlax/ },
    ],
    // Measured with Jev playing the rest (lead-sweep.mjs + batches): every lead scores about 3
    // (Ariados 2.89 over 9 battles, Machamp 3.00 over 6) except Heracross 4.33 over 3: no clear answer yet.
    expect: null,
  },
  {
    name: 'lead (team 2026): avoids the Hyper Beam lead',
    why: 'Ninetales beats Pikachu with Hyper Beam, then loses a turn to RED\'s next Pokémon.',
    type: 'lead',
    party: team('2026'),
    prompt: [
      { option: 'lead_Ninetales', contains: /Recharge cost|losing a turn to recharge/ },
      // RED's replacement is chosen against your lead (84% right on logged replacements):
      // after Ninetales, Snorlax (no answer on this team); after Crobat, Espeon (Crobat beats it).
      { option: 'lead_Ninetales', contains: /Next: [^.]*send in Snorlax[^.]*none of your other Pokémon wins/ },
      { option: 'lead_Crobat', contains: /Next: [^.]*send in Espeon[^.]*Crobat then beats it/ },
    ],
    // Measured with Jev playing the rest: Crobat 4.40 (15 battles); Ninetales 3.00 (3).
    expect: { avoid: ['lead_Ninetales'] },
  },
  {
    name: 'lead (team 4159547863): keeps the only answer to Venusaur',
    why: 'Jynx is the only Pokémon on this team that beats Venusaur one-on-one.',
    type: 'lead',
    party: team('4159547863'),
    prompt: [
      { option: 'lead_Jynx', contains: /only Pokémon that beats Venusaur/ },
      { option: 'lead_Jynx', contains: /Lead cost: [^.]*Venusaur/ },
    ],
    // Measured with Jev playing the rest: Dugtrio 4.33 (15 battles), Houndoom 4.33 (3); Jynx 2.00 (3).
    expect: { avoid: ['lead_Jynx'] },
  },
  {
    name: 'lead (team 777): avoids a lead that loses to Pikachu',
    why: 'Every lead option states how often it beats Pikachu.',
    type: 'lead',
    party: team('777'),
    prompt: ['Quagsire', 'Chimecho', 'Pinsir', 'Jolteon', 'Tyranitar', 'Wigglytuff'].map((n) => ({ option: `lead_${n}`, contains: /Lead exchange: / })),
    // Measured with Jev playing the rest: the top five are within noise (4.3-5.3); Pinsir 1.67 (3 battles).
    expect: { avoid: ['lead_Pinsir'] },
  },
  {
    name: 'sets up to break through a Pokémon that heals with Rest',
    why: "Snorlax uses Rest whenever Slash wears it down, so plain Slash rarely finishes it (about 13% in the simulation with RED's AI); after Swords Dance, Slash knocks it out before Rest catches up (about 100%). Live, OpenAI used Slash 19 turns in a row here.",
    type: 'action',
    battle: () => makeBattle({
      you: mon('Scizor', { moves: ['Swords Dance', 'Slash', 'False Swipe', 'Cut'], pp: [30, 19, 40, 30] }),
      foe: red('Snorlax'),
      bench: [mon('Milotic', { moves: ['Water Gun', 'Twister'] })],
    }),
    prompt: [{ option: 'move_1', contains: /^Plan: Swords Dance first, then Slash: Scizor wins this one-on-one about \d+% of the time/ }],
    expect: { pick: ['move_1'] },
  },
];
