import { ELEMENTS, type Element } from './elements';

/**
 * The roster.
 *
 * Six evolution lines, one per element, three stages each. Every creature is
 * original: the art is generated from the `art` spec below by
 * `components/CreatureArt.tsx`, so the game ships no third-party sprites and no
 * runtime image requests. Names carry a Chinese translation alongside English
 * because the player is bilingual.
 */

export type BodyShape = 'blob' | 'round' | 'tall' | 'spiky';
export type EyeStyle = 'big' | 'sleepy' | 'fierce' | 'star';
export type Crown = 'none' | 'flame' | 'leaf' | 'crystal' | 'bolt' | 'rock' | 'fin' | 'horn';
export type Tail = 'none' | 'puff' | 'blade' | 'curl' | 'spark';
export type Pattern = 'none' | 'spots' | 'stripes' | 'belly';

/** Everything the SVG renderer needs to draw a creature. */
export type ArtSpec = {
  shape: BodyShape;
  eyes: EyeStyle;
  crown: Crown;
  tail: Tail;
  pattern: Pattern;
  /** Body fill. */
  primary: string;
  /** Belly / accent fill. */
  secondary: string;
  /** Crown, tail tip, pattern marks. */
  accent: string;
  /** Relative render scale; later evolutions loom larger. */
  scale: number;
};

export type Creature = {
  id: string;
  name: { en: string; zh: string };
  element: Element;
  /** 1, 2 or 3. Stage 1 creatures are the ones a new player can start with. */
  stage: 1 | 2 | 3;
  /** Next creature id in the line, or null at the top. */
  evolvesTo: string | null;
  /** Trainer level at which this creature starts showing up in the wild. */
  unlockLevel: number;
  baseHp: number;
  baseAtk: number;
  flavor: { en: string; zh: string };
  art: ArtSpec;
};

/** Stat curve per stage - kept in one place so lines stay comparable. */
const STAGE_STATS = {
  1: { hp: 55, atk: 9 },
  2: { hp: 80, atk: 13 },
  3: { hp: 110, atk: 18 },
} as const;

type LineEntry = {
  id: string;
  en: string;
  zh: string;
  flavorEn: string;
  flavorZh: string;
  art: Omit<ArtSpec, 'primary' | 'secondary' | 'accent' | 'scale'>;
};

type Line = {
  element: Element;
  palette: { primary: string; secondary: string; accent: string };
  stages: [LineEntry, LineEntry, LineEntry];
};

const LINES: Line[] = [
  {
    element: 'ember',
    palette: { primary: '#ff7a45', secondary: '#ffd9c2', accent: '#ffd23f' },
    stages: [
      {
        id: 'cindik',
        en: 'Cindik',
        zh: '小火星',
        flavorEn: 'A pocket-sized spark that hiccups tiny flames when excited.',
        flavorZh: '口袋大小的小火苗，一激动就会打出小火花。',
        art: { shape: 'blob', eyes: 'big', crown: 'flame', tail: 'puff', pattern: 'belly' },
      },
      {
        id: 'blazur',
        en: 'Blazur',
        zh: '烈焰兽',
        flavorEn: 'Its mane burns brighter the longer a battle goes on.',
        flavorZh: '战斗越久，鬃毛燃烧得越旺。',
        art: { shape: 'round', eyes: 'fierce', crown: 'flame', tail: 'blade', pattern: 'stripes' },
      },
      {
        id: 'pyrolith',
        en: 'Pyrolith',
        zh: '炎岩王',
        flavorEn: 'Molten armour that cooled into cracked, glowing plates.',
        flavorZh: '熔岩冷却成开裂发光的铠甲。',
        art: { shape: 'spiky', eyes: 'fierce', crown: 'horn', tail: 'blade', pattern: 'stripes' },
      },
    ],
  },
  {
    element: 'frost',
    palette: { primary: '#a8ecfa', secondary: '#f2fdff', accent: '#4fb8d8' },
    stages: [
      {
        id: 'flurro',
        en: 'Flurro',
        zh: '雪绒球',
        flavorEn: 'A drifting snow puff. It sneezes hailstones.',
        flavorZh: '飘浮的雪球，打喷嚏会喷出冰雹。',
        art: { shape: 'round', eyes: 'sleepy', crown: 'none', tail: 'puff', pattern: 'spots' },
      },
      {
        id: 'frostix',
        en: 'Frostix',
        zh: '冰晶兽',
        flavorEn: 'Grows a new crystal spike for every battle it survives.',
        flavorZh: '每挺过一场战斗，就长出一根新的冰晶。',
        art: { shape: 'spiky', eyes: 'big', crown: 'crystal', tail: 'blade', pattern: 'belly' },
      },
      {
        id: 'glacian',
        en: 'Glacian',
        zh: '冰川王',
        flavorEn: 'Ancient and slow-moving, it carries a whole winter with it.',
        flavorZh: '古老而缓慢，它随身带着一整个冬天。',
        art: { shape: 'tall', eyes: 'fierce', crown: 'crystal', tail: 'curl', pattern: 'stripes' },
      },
    ],
  },
  {
    element: 'leaf',
    palette: { primary: '#5fd98a', secondary: '#dcf7e3', accent: '#f2b705' },
    stages: [
      {
        id: 'sproutle',
        en: 'Sproutle',
        zh: '小芽苗',
        flavorEn: 'Naps in sunbeams and grows a little taller each time.',
        flavorZh: '在阳光下打盹，每次醒来都长高一点。',
        art: { shape: 'blob', eyes: 'sleepy', crown: 'leaf', tail: 'curl', pattern: 'belly' },
      },
      {
        id: 'vinari',
        en: 'Vinari',
        zh: '藤蔓兽',
        flavorEn: 'Its vines can solve a knot faster than most trainers can.',
        flavorZh: '它的藤蔓解结的速度比大多数训练家还快。',
        art: { shape: 'tall', eyes: 'big', crown: 'leaf', tail: 'curl', pattern: 'stripes' },
      },
      {
        id: 'thornmoss',
        en: 'Thornmoss',
        zh: '荆棘王',
        flavorEn: 'A walking thicket. Forests grow quiet when it passes.',
        flavorZh: '会走路的荆棘丛，它经过时森林都安静下来。',
        art: { shape: 'spiky', eyes: 'fierce', crown: 'leaf', tail: 'blade', pattern: 'spots' },
      },
    ],
  },
  {
    element: 'stone',
    palette: { primary: '#c49a72', secondary: '#f0e0cf', accent: '#8a6a4a' },
    stages: [
      {
        id: 'pebblo',
        en: 'Pebblo',
        zh: '小石子',
        flavorEn: 'Pretends to be an ordinary rock until someone says hello.',
        flavorZh: '假装成普通石头，直到有人跟它打招呼。',
        art: { shape: 'round', eyes: 'big', crown: 'rock', tail: 'none', pattern: 'spots' },
      },
      {
        id: 'boulderin',
        en: 'Boulderin',
        zh: '巨岩兽',
        flavorEn: 'Rolls downhill on purpose. Stopping is the hard part.',
        flavorZh: '故意从山坡滚下来，难的是怎么停住。',
        art: { shape: 'blob', eyes: 'fierce', crown: 'rock', tail: 'puff', pattern: 'spots' },
      },
      {
        id: 'granitor',
        en: 'Granitor',
        zh: '花岗王',
        flavorEn: 'Older than the mountain it was chipped from.',
        flavorZh: '比它剥落的那座山还要古老。',
        art: { shape: 'tall', eyes: 'fierce', crown: 'horn', tail: 'blade', pattern: 'stripes' },
      },
    ],
  },
  {
    element: 'spark',
    palette: { primary: '#ffd93f', secondary: '#fff6cc', accent: '#ff8f1f' },
    stages: [
      {
        id: 'zaplet',
        en: 'Zaplet',
        zh: '电光虫',
        flavorEn: 'Buzzes with static. Petting it makes your hair stand up.',
        flavorZh: '浑身静电，摸一下头发就竖起来了。',
        art: { shape: 'round', eyes: 'star', crown: 'bolt', tail: 'spark', pattern: 'spots' },
      },
      {
        id: 'voltari',
        en: 'Voltari',
        zh: '雷电兽',
        flavorEn: 'Runs so fast it leaves a trail of sparks behind it.',
        flavorZh: '跑得飞快，身后拖着一串火花。',
        art: { shape: 'tall', eyes: 'fierce', crown: 'bolt', tail: 'spark', pattern: 'stripes' },
      },
      {
        id: 'thundrax',
        en: 'Thundrax',
        zh: '雷霆王',
        flavorEn: 'Storm clouds gather wherever it decides to nap.',
        flavorZh: '它在哪里打盹，乌云就在哪里聚集。',
        art: { shape: 'spiky', eyes: 'fierce', crown: 'bolt', tail: 'spark', pattern: 'stripes' },
      },
    ],
  },
  {
    element: 'aqua',
    palette: { primary: '#4fb0ff', secondary: '#d6ecff', accent: '#1f6fd0' },
    stages: [
      {
        id: 'bublet',
        en: 'Bublet',
        zh: '小水泡',
        flavorEn: 'Made almost entirely of bubbles. Pops when it laughs.',
        flavorZh: '几乎全是泡泡做的，一笑就会破掉。',
        art: { shape: 'round', eyes: 'big', crown: 'fin', tail: 'curl', pattern: 'belly' },
      },
      {
        id: 'splashen',
        en: 'Splashen',
        zh: '浪花兽',
        flavorEn: 'Surfs on its own tail. Refuses to walk anywhere.',
        flavorZh: '踩着自己的尾巴冲浪，绝不肯走路。',
        art: { shape: 'blob', eyes: 'star', crown: 'fin', tail: 'blade', pattern: 'stripes' },
      },
      {
        id: 'tidalus',
        en: 'Tidalus',
        zh: '潮汐王',
        flavorEn: 'The tide follows it, not the moon.',
        flavorZh: '潮水跟随的是它，而不是月亮。',
        art: { shape: 'tall', eyes: 'fierce', crown: 'fin', tail: 'blade', pattern: 'belly' },
      },
    ],
  },
];

/** Trainer level at which each stage begins appearing in the wild. */
const STAGE_UNLOCK = { 1: 1, 2: 4, 3: 8 } as const;

function buildRoster(): Creature[] {
  const out: Creature[] = [];
  for (const line of LINES) {
    line.stages.forEach((entry, index) => {
      const stage = (index + 1) as 1 | 2 | 3;
      const stats = STAGE_STATS[stage];
      out.push({
        id: entry.id,
        name: { en: entry.en, zh: entry.zh },
        element: line.element,
        stage,
        evolvesTo: line.stages[index + 1]?.id ?? null,
        unlockLevel: STAGE_UNLOCK[stage],
        baseHp: stats.hp,
        baseAtk: stats.atk,
        flavor: { en: entry.flavorEn, zh: entry.flavorZh },
        art: {
          ...entry.art,
          primary: line.palette.primary,
          secondary: line.palette.secondary,
          accent: line.palette.accent,
          scale: 0.85 + stage * 0.09,
        },
      });
    });
  }
  return out;
}

export const CREATURES: readonly Creature[] = Object.freeze(buildRoster());

const BY_ID = new Map(CREATURES.map((c) => [c.id, c]));

/** Throws on an unknown id - a typo in a save file should not silently pass. */
export function getCreature(id: string): Creature {
  const found = BY_ID.get(id);
  if (!found) throw new Error(`Unknown creature id: ${id}`);
  return found;
}

export function findCreature(id: string): Creature | undefined {
  return BY_ID.get(id);
}

/** The six stage-1 creatures a new trainer chooses their first partner from. */
export function starters(): Creature[] {
  return CREATURES.filter((c) => c.stage === 1);
}

export function creaturesByElement(element: Element): Creature[] {
  return CREATURES.filter((c) => c.element === element);
}

/** Wild creatures a trainer of this level can run into. */
export function availableAtLevel(level: number): Creature[] {
  return CREATURES.filter((c) => c.unlockLevel <= level);
}

/** Walks the evolution line from any member back to its stage-1 root. */
export function evolutionLine(id: string): Creature[] {
  const target = getCreature(id);
  const root = CREATURES.find((c) => c.stage === 1 && c.element === target.element);
  if (!root) throw new Error(`No stage-1 creature for element ${target.element}`);

  const line: Creature[] = [root];
  let current = root;
  while (current.evolvesTo) {
    current = getCreature(current.evolvesTo);
    line.push(current);
  }
  return line;
}

/**
 * Effective stats for a creature at a given trainer level.
 * Growth is gentle and linear so a child can predict it.
 */
export function statsAtLevel(creature: Creature, level: number): { hp: number; atk: number } {
  const growth = Math.max(0, level - 1);
  return {
    hp: creature.baseHp + growth * 6,
    atk: creature.baseAtk + growth * 2,
  };
}

/** Sanity guard: the roster must stay one full line per element. */
export function rosterIsComplete(): boolean {
  return ELEMENTS.every((element) => {
    const line = creaturesByElement(element);
    return line.length === 3 && line.map((c) => c.stage).join(',') === '1,2,3';
  });
}
