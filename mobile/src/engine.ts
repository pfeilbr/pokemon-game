/**
 * The shared game engine.
 *
 * Every rule the iOS client plays by comes from the same modules the web app
 * uses - `../../src/lib/game/`. Nothing is duplicated, so a balance fix or a
 * new creature reaches both clients at once, and the 194 engine tests at the
 * repository root cover this client too.
 *
 * This file is the single place that knows the path across the directory
 * boundary; everything else in the app imports from here.
 */

export {
  CREATURES,
  type Creature,
  getCreature,
  starters,
  statsAtLevel,
} from '../../src/lib/game/creatures';

export {
  ELEMENTS,
  ELEMENT_STYLE,
  type Element,
  effectiveness,
  strongAgainst,
  weakTo,
} from '../../src/lib/game/elements';

export { generateProblem, type Problem } from '../../src/lib/game/math';

export { movesFor, type Move } from '../../src/lib/game/moves';

export {
  type BattleState,
  availableMoves,
  battleReducer,
  createBattle,
  summarise,
} from '../../src/lib/game/battle';

export {
  type Language,
  type Profile,
  createProfile,
  levelFromXp,
  normaliseProfile,
  partnerFor,
} from '../../src/lib/game/progress';

export { STRINGS, t } from '../../src/lib/i18n';
