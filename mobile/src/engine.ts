/**
 * The shared game engine.
 *
 * Every rule the iOS client plays by comes from the same modules the web app
 * uses - `../../src/lib/game/`. Nothing is duplicated, so a balance fix or a
 * new creature reaches both clients at once, and the engine tests at the
 * repository root cover this client too.
 *
 * This file is the single place that knows the path across the directory
 * boundary; everything else in the app imports from here.
 */

export {
  CREATURES,
  type ArtSpec,
  type Creature,
  availableAtLevel,
  evolutionLine,
  findCreature,
  getCreature,
  starters,
  statsAtLevel,
} from '../../src/lib/game/creatures';

export {
  ELEMENTS,
  ELEMENT_STYLE,
  NEUTRAL,
  NOT_VERY_EFFECTIVE,
  SUPER_EFFECTIVE,
  type Element,
  effectiveness,
  strongAgainst,
  weakTo,
} from '../../src/lib/game/elements';

export {
  MAX_TIER,
  SKILL_META,
  type Attempt,
  type Problem,
  type Skill,
  type SkillStat,
  accuracyOf,
  averageSeconds,
  generateProblem,
  skillsForTier,
} from '../../src/lib/game/math';

export { MAX_CHARGE, type Move, movesFor } from '../../src/lib/game/moves';

export {
  CRIT_THRESHOLD,
  MAX_SPEED_BONUS,
  type BattleState,
  availableMoves,
  battleReducer,
  createBattle,
  speedFraction,
  summarise,
} from '../../src/lib/game/battle';

export {
  BADGES,
  MAX_LEVEL,
  type Badge,
  type BattleOutcome,
  type Language,
  type Profile,
  applyBattleResult,
  badgeById,
  completion,
  createProfile,
  levelFromXp,
  levelProgress,
  nextEvolutionLevel,
  normaliseProfile,
  overallAccuracy,
  partnerFor,
} from '../../src/lib/game/progress';

export { createRng } from '../../src/lib/game/rng';

export { STRINGS, type StringKey, t } from '../../src/lib/i18n';
