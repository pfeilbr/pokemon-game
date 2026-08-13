import { ELEMENTS, type Element } from './elements';

/**
 * The roster.
 *
 * Twelve evolution lines - two per element - of three stages each. Every
 * creature is original: the art is generated from the `art` spec below by
 * `art.ts`, so the game ships no third-party sprites and makes no runtime image
 * requests. The only image file outside the documentation screenshots is the
 * app icon, which is hand-written vector primitives; `scripts/audit_assets.py`
 * enforces that. Names carry a Chinese translation alongside
 * English because the player is bilingual.
 *
 * Two lines per element rather than one is what makes an album worth filling:
 * six creatures per element means a wild encounter is a real surprise, while
 * the type chart a seven-year-old has to hold in his head stays at six.
 */

export type BodyShape = 'blob' | 'round' | 'tall' | 'spiky' | 'serpent' | 'beast';
export type EyeStyle = 'big' | 'sleepy' | 'fierce' | 'star' | 'visor';
export type Crown =
  'none' | 'flame' | 'leaf' | 'crystal' | 'bolt' | 'rock' | 'fin' | 'horn' | 'antler' | 'plume';
export type Tail = 'none' | 'puff' | 'blade' | 'curl' | 'spark' | 'fan' | 'lash';
export type Pattern = 'none' | 'spots' | 'stripes' | 'belly' | 'plates' | 'swirl';
/** Surface detail. What stops a large creature reading as one flat colour. */
export type Texture = 'smooth' | 'fur' | 'scales' | 'crystal' | 'rocky';
export type Ears = 'none' | 'round' | 'pointed' | 'long' | 'frill';
export type Wings = 'none' | 'membrane' | 'feather' | 'insect';
/** Ambient particles. Final forms only, so evolving is visibly a promotion. */
export type Aura = 'none' | 'embers' | 'frost' | 'leaves' | 'dust' | 'sparks' | 'bubbles';

/** Everything the renderer needs to draw a creature. */
export type ArtSpec = {
  shape: BodyShape;
  eyes: EyeStyle;
  crown: Crown;
  tail: Tail;
  pattern: Pattern;
  texture: Texture;
  ears: Ears;
  wings: Wings;
  aura: Aura;
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
  /**
   * Which evolution line this belongs to. Two lines share an element, so the
   * line - not the element - is what `evolutionLine` walks.
   */
  lineId: string;
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

type LineArt = Omit<ArtSpec, 'primary' | 'secondary' | 'accent' | 'scale'>;

type LineEntry = {
  id: string;
  en: string;
  zh: string;
  flavorEn: string;
  flavorZh: string;
  art: LineArt;
};

type Line = {
  id: string;
  element: Element;
  palette: { primary: string; secondary: string; accent: string };
  stages: [LineEntry, LineEntry, LineEntry];
};

const LINES: Line[] = [
  // -------------------------------------------------------------- ember ----
  {
    id: 'ember-spark',
    element: 'ember',
    palette: { primary: '#ff7a45', secondary: '#ffd9c2', accent: '#ffd23f' },
    stages: [
      {
        id: 'cindik',
        en: 'Cindik',
        zh: '小火星',
        flavorEn: 'A pocket-sized spark that hiccups tiny flames when excited.',
        flavorZh: '口袋大小的小火苗，一激动就会打出小火花。',
        art: {
          shape: 'blob',
          eyes: 'big',
          crown: 'flame',
          tail: 'puff',
          pattern: 'belly',
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'blazur',
        en: 'Blazur',
        zh: '烈焰兽',
        flavorEn: 'Its mane burns brighter the longer a battle goes on.',
        flavorZh: '战斗越久，鬃毛燃烧得越旺。',
        art: {
          shape: 'round',
          eyes: 'fierce',
          crown: 'flame',
          tail: 'blade',
          pattern: 'stripes',
          texture: 'fur',
          ears: 'pointed',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'pyrolith',
        en: 'Pyrolith',
        zh: '炎岩王',
        flavorEn: 'Molten armour that cooled into cracked, glowing plates.',
        flavorZh: '熔岩冷却成开裂发光的铠甲。',
        art: {
          shape: 'spiky',
          eyes: 'fierce',
          crown: 'horn',
          tail: 'blade',
          pattern: 'plates',
          texture: 'rocky',
          ears: 'none',
          wings: 'none',
          aura: 'embers',
        },
      },
    ],
  },
  {
    id: 'ember-hound',
    element: 'ember',
    palette: { primary: '#e8543a', secondary: '#ffcbb0', accent: '#ff9f1c' },
    stages: [
      {
        id: 'cinderpup',
        en: 'Cinderpup',
        zh: '炭火犬',
        flavorEn: 'A stray ember that decided it would rather have paws.',
        flavorZh: '一颗流浪的火星，决定给自己长出四只爪子。',
        art: {
          shape: 'beast',
          eyes: 'big',
          crown: 'none',
          tail: 'lash',
          pattern: 'belly',
          texture: 'fur',
          ears: 'pointed',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'ashfang',
        en: 'Ashfang',
        zh: '灰烬牙',
        flavorEn: 'Scorches a neat circle into the grass wherever it sleeps.',
        flavorZh: '睡在哪里，草地上就烧出一个整齐的圆圈。',
        art: {
          shape: 'beast',
          eyes: 'fierce',
          crown: 'horn',
          tail: 'lash',
          pattern: 'stripes',
          texture: 'fur',
          ears: 'pointed',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'magmaris',
        en: 'Magmaris',
        zh: '岩浆兽',
        flavorEn: 'Wherever it runs, the ground remembers the heat for days.',
        flavorZh: '它跑过的地方，大地会记住那股热度好几天。',
        art: {
          shape: 'beast',
          eyes: 'fierce',
          crown: 'antler',
          tail: 'fan',
          pattern: 'plates',
          texture: 'rocky',
          ears: 'none',
          wings: 'none',
          aura: 'embers',
        },
      },
    ],
  },

  // -------------------------------------------------------------- frost ----
  {
    id: 'frost-puff',
    element: 'frost',
    palette: { primary: '#a8ecfa', secondary: '#f2fdff', accent: '#4fb8d8' },
    stages: [
      {
        id: 'flurro',
        en: 'Flurro',
        zh: '雪绒球',
        flavorEn: 'A drifting snow puff. It sneezes hailstones.',
        flavorZh: '飘浮的雪球，打喷嚏会喷出冰雹。',
        art: {
          shape: 'round',
          eyes: 'sleepy',
          crown: 'none',
          tail: 'puff',
          pattern: 'spots',
          texture: 'fur',
          ears: 'round',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'frostix',
        en: 'Frostix',
        zh: '冰晶兽',
        flavorEn: 'Grows a new crystal spike for every battle it survives.',
        flavorZh: '每挺过一场战斗，就长出一根新的冰晶。',
        art: {
          shape: 'spiky',
          eyes: 'big',
          crown: 'crystal',
          tail: 'blade',
          pattern: 'belly',
          texture: 'crystal',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'glacian',
        en: 'Glacian',
        zh: '冰川王',
        flavorEn: 'Ancient and slow-moving, it carries a whole winter with it.',
        flavorZh: '古老而缓慢，它随身带着一整个冬天。',
        art: {
          shape: 'tall',
          eyes: 'fierce',
          crown: 'crystal',
          tail: 'curl',
          pattern: 'plates',
          texture: 'crystal',
          ears: 'frill',
          wings: 'none',
          aura: 'frost',
        },
      },
    ],
  },
  {
    id: 'frost-coil',
    element: 'frost',
    palette: { primary: '#7fd4ee', secondary: '#e8fbff', accent: '#3b8fc4' },
    stages: [
      {
        id: 'chillcoil',
        en: 'Chillcoil',
        zh: '寒霜蛇',
        flavorEn: 'Sleeps in a tidy spiral and wakes up as a snowdrift.',
        flavorZh: '盘成整齐的一圈睡觉，醒来时变成一堆雪。',
        art: {
          shape: 'serpent',
          eyes: 'sleepy',
          crown: 'none',
          tail: 'none',
          pattern: 'none',
          texture: 'scales',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'rimeserp',
        en: 'Rimeserp',
        zh: '霜鳞蟒',
        flavorEn: 'Its scales ring like thin glass whenever it moves.',
        flavorZh: '它一动，鳞片就像薄玻璃一样清脆作响。',
        art: {
          shape: 'serpent',
          eyes: 'big',
          crown: 'fin',
          tail: 'none',
          pattern: 'swirl',
          texture: 'scales',
          ears: 'frill',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'permafang',
        en: 'Permafang',
        zh: '万年冰蟒',
        flavorEn: 'Old enough to remember when the lake at the top was warm.',
        flavorZh: '它老得记得山顶那片湖还温暖的时候。',
        art: {
          shape: 'serpent',
          eyes: 'fierce',
          crown: 'crystal',
          tail: 'none',
          pattern: 'plates',
          texture: 'crystal',
          ears: 'frill',
          wings: 'none',
          aura: 'frost',
        },
      },
    ],
  },

  // --------------------------------------------------------------- leaf ----
  {
    id: 'leaf-sprout',
    element: 'leaf',
    palette: { primary: '#5fd98a', secondary: '#dcf7e3', accent: '#f2b705' },
    stages: [
      {
        id: 'sproutle',
        en: 'Sproutle',
        zh: '小芽苗',
        flavorEn: 'Naps in sunbeams and grows a little taller each time.',
        flavorZh: '在阳光下打盹，每次醒来都长高一点。',
        art: {
          shape: 'blob',
          eyes: 'sleepy',
          crown: 'leaf',
          tail: 'curl',
          pattern: 'belly',
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'vinari',
        en: 'Vinari',
        zh: '藤蔓兽',
        flavorEn: 'Its vines can untie a knot faster than most trainers can.',
        flavorZh: '它的藤蔓解结的速度比大多数训练家还快。',
        art: {
          shape: 'tall',
          eyes: 'big',
          crown: 'leaf',
          tail: 'curl',
          pattern: 'stripes',
          texture: 'smooth',
          ears: 'long',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'thornmoss',
        en: 'Thornmoss',
        zh: '荆棘王',
        flavorEn: 'A walking thicket. Forests go quiet when it passes.',
        flavorZh: '会走路的荆棘丛，它经过时森林都安静下来。',
        art: {
          shape: 'spiky',
          eyes: 'fierce',
          crown: 'leaf',
          tail: 'blade',
          pattern: 'spots',
          texture: 'fur',
          ears: 'none',
          wings: 'none',
          aura: 'leaves',
        },
      },
    ],
  },
  {
    id: 'leaf-moth',
    element: 'leaf',
    palette: { primary: '#7bc96f', secondary: '#eaf9d9', accent: '#d98cb3' },
    stages: [
      {
        id: 'petalix',
        en: 'Petalix',
        zh: '花瓣虫',
        flavorEn: 'Rides the wind by pretending to be a falling petal.',
        flavorZh: '假装成一片飘落的花瓣，借着风到处跑。',
        art: {
          shape: 'round',
          eyes: 'visor',
          crown: 'none',
          tail: 'none',
          pattern: 'spots',
          texture: 'smooth',
          ears: 'long',
          wings: 'insect',
          aura: 'none',
        },
      },
      {
        id: 'blossomoth',
        en: 'Blossomoth',
        zh: '花斑蛾',
        flavorEn: 'Dusts the air with pollen that smells like the whole summer.',
        flavorZh: '在空中撒下花粉，闻起来像整个夏天。',
        art: {
          shape: 'round',
          eyes: 'visor',
          crown: 'plume',
          tail: 'fan',
          pattern: 'swirl',
          texture: 'fur',
          ears: 'long',
          wings: 'insect',
          aura: 'none',
        },
      },
      {
        id: 'verdawing',
        en: 'Verdawing',
        zh: '翠翼王',
        flavorEn: 'Whole meadows lean to follow the path of its wings.',
        flavorZh: '整片草地都会跟着它的翅膀倾斜。',
        art: {
          shape: 'tall',
          eyes: 'visor',
          crown: 'plume',
          tail: 'fan',
          pattern: 'stripes',
          texture: 'fur',
          ears: 'frill',
          wings: 'insect',
          aura: 'leaves',
        },
      },
    ],
  },

  // -------------------------------------------------------------- stone ----
  {
    id: 'stone-pebble',
    element: 'stone',
    palette: { primary: '#c49a72', secondary: '#f0e0cf', accent: '#8a6a4a' },
    stages: [
      {
        id: 'pebblo',
        en: 'Pebblo',
        zh: '小石子',
        flavorEn: 'Pretends to be an ordinary rock until someone says hello.',
        flavorZh: '假装成普通石头，直到有人跟它打招呼。',
        art: {
          shape: 'round',
          eyes: 'big',
          crown: 'rock',
          tail: 'none',
          pattern: 'spots',
          texture: 'rocky',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'boulderin',
        en: 'Boulderin',
        zh: '巨岩兽',
        flavorEn: 'Rolls downhill on purpose. Stopping is the hard part.',
        flavorZh: '故意从山坡滚下来，难的是怎么停住。',
        art: {
          shape: 'blob',
          eyes: 'fierce',
          crown: 'rock',
          tail: 'puff',
          pattern: 'spots',
          texture: 'rocky',
          ears: 'round',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'granitor',
        en: 'Granitor',
        zh: '花岗王',
        flavorEn: 'Older than the mountain it was chipped from.',
        flavorZh: '比它剥落的那座山还要古老。',
        art: {
          shape: 'tall',
          eyes: 'fierce',
          crown: 'horn',
          tail: 'blade',
          pattern: 'plates',
          texture: 'rocky',
          ears: 'none',
          wings: 'none',
          aura: 'dust',
        },
      },
    ],
  },
  {
    id: 'stone-crag',
    element: 'stone',
    // Cool slate against the other stone line's warm sandstone. Both lines were
    // brown, which made six stone creatures look like the same three twice.
    palette: { primary: '#8d9aa8', secondary: '#dfe7ef', accent: '#55647a' },
    stages: [
      {
        id: 'gravlet',
        en: 'Gravlet',
        zh: '小砾兽',
        flavorEn: 'Collects interesting pebbles and refuses to share any of them.',
        flavorZh: '收集好看的小石头，一颗也不肯分给别人。',
        art: {
          shape: 'beast',
          eyes: 'big',
          crown: 'rock',
          tail: 'none',
          pattern: 'spots',
          texture: 'rocky',
          ears: 'round',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'cragmaul',
        en: 'Cragmaul',
        zh: '崖颚兽',
        flavorEn: 'Chews granite the way other creatures chew grass.',
        flavorZh: '嚼花岗岩就像别的伙伴嚼草一样。',
        art: {
          shape: 'beast',
          eyes: 'fierce',
          crown: 'horn',
          tail: 'blade',
          pattern: 'plates',
          texture: 'rocky',
          ears: 'pointed',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'monolyth',
        en: 'Monolyth',
        zh: '石碑王',
        flavorEn: 'Stands so still that old maps mark it as a landmark.',
        flavorZh: '站得太久太稳，旧地图把它标成了地标。',
        art: {
          shape: 'tall',
          eyes: 'fierce',
          crown: 'antler',
          tail: 'none',
          pattern: 'plates',
          texture: 'rocky',
          ears: 'none',
          wings: 'none',
          aura: 'dust',
        },
      },
    ],
  },

  // -------------------------------------------------------------- spark ----
  {
    id: 'spark-bug',
    element: 'spark',
    palette: { primary: '#ffd93f', secondary: '#fff6cc', accent: '#ff8f1f' },
    stages: [
      {
        id: 'zaplet',
        en: 'Zaplet',
        zh: '电光虫',
        flavorEn: 'Buzzes with static. Petting it makes your hair stand up.',
        flavorZh: '浑身静电，摸一下头发就竖起来了。',
        art: {
          shape: 'round',
          eyes: 'star',
          crown: 'bolt',
          tail: 'spark',
          pattern: 'spots',
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'voltari',
        en: 'Voltari',
        zh: '雷电兽',
        flavorEn: 'Runs so fast it leaves a trail of sparks behind it.',
        flavorZh: '跑得飞快，身后拖着一串火花。',
        art: {
          shape: 'tall',
          eyes: 'fierce',
          crown: 'bolt',
          tail: 'spark',
          pattern: 'stripes',
          texture: 'fur',
          ears: 'pointed',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'thundrax',
        en: 'Thundrax',
        zh: '雷霆王',
        flavorEn: 'Storm clouds gather wherever it decides to nap.',
        flavorZh: '它在哪里打盹，乌云就在哪里聚集。',
        art: {
          shape: 'spiky',
          eyes: 'fierce',
          crown: 'bolt',
          tail: 'spark',
          pattern: 'stripes',
          texture: 'crystal',
          ears: 'none',
          wings: 'none',
          aura: 'sparks',
        },
      },
    ],
  },
  {
    id: 'spark-bird',
    element: 'spark',
    palette: { primary: '#f7c948', secondary: '#fff3d0', accent: '#c77dff' },
    stages: [
      {
        id: 'voltick',
        en: 'Voltick',
        zh: '电光雀',
        flavorEn: 'Charges itself up by sitting on the windiest hill it can find.',
        flavorZh: '找一座最有风的小山坐下来，给自己充电。',
        art: {
          shape: 'round',
          eyes: 'star',
          crown: 'plume',
          tail: 'fan',
          pattern: 'belly',
          texture: 'smooth',
          ears: 'none',
          wings: 'feather',
          aura: 'none',
        },
      },
      {
        id: 'stormquill',
        en: 'Stormquill',
        zh: '雷羽鸟',
        flavorEn: 'Every feather holds a little of the last storm it flew through.',
        flavorZh: '每一根羽毛都藏着上一场暴风雨的一点点。',
        art: {
          shape: 'tall',
          eyes: 'fierce',
          crown: 'plume',
          tail: 'fan',
          pattern: 'swirl',
          texture: 'smooth',
          ears: 'none',
          wings: 'feather',
          aura: 'none',
        },
      },
      {
        id: 'aetherax',
        en: 'Aetherax',
        zh: '苍穹雷王',
        flavorEn: 'Flies above the clouds and drops the thunder from up there.',
        flavorZh: '飞到云层之上，从那里把雷声丢下来。',
        art: {
          shape: 'tall',
          eyes: 'fierce',
          crown: 'bolt',
          tail: 'fan',
          pattern: 'plates',
          texture: 'crystal',
          ears: 'frill',
          wings: 'feather',
          aura: 'sparks',
        },
      },
    ],
  },

  // --------------------------------------------------------------- aqua ----
  {
    id: 'aqua-bubble',
    element: 'aqua',
    palette: { primary: '#4fb0ff', secondary: '#d6ecff', accent: '#1f6fd0' },
    stages: [
      {
        id: 'bublet',
        en: 'Bublet',
        zh: '小水泡',
        flavorEn: 'Made almost entirely of bubbles. Pops when it laughs.',
        flavorZh: '几乎全是泡泡做的，一笑就会破掉。',
        art: {
          shape: 'round',
          eyes: 'big',
          crown: 'fin',
          tail: 'curl',
          pattern: 'belly',
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'splashen',
        en: 'Splashen',
        zh: '浪花兽',
        flavorEn: 'Surfs on its own tail. Refuses to walk anywhere.',
        flavorZh: '踩着自己的尾巴冲浪，绝不肯走路。',
        art: {
          shape: 'blob',
          eyes: 'star',
          crown: 'fin',
          tail: 'blade',
          pattern: 'stripes',
          texture: 'smooth',
          ears: 'frill',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'tidalus',
        en: 'Tidalus',
        zh: '潮汐王',
        flavorEn: 'The tide follows it, not the moon.',
        flavorZh: '潮水跟随的是它，而不是月亮。',
        art: {
          shape: 'tall',
          eyes: 'fierce',
          crown: 'fin',
          tail: 'blade',
          pattern: 'belly',
          texture: 'scales',
          ears: 'frill',
          wings: 'none',
          aura: 'bubbles',
        },
      },
    ],
  },
  {
    id: 'aqua-current',
    element: 'aqua',
    palette: { primary: '#3d94e0', secondary: '#cbe8ff', accent: '#14539e' },
    stages: [
      {
        id: 'rivulet',
        en: 'Rivulet',
        zh: '小溪灵',
        flavorEn: 'A stream that got curious one day and wandered off.',
        flavorZh: '一条小溪某天起了好奇心，就自己跑掉了。',
        art: {
          shape: 'serpent',
          eyes: 'big',
          crown: 'none',
          tail: 'none',
          pattern: 'swirl',
          texture: 'smooth',
          ears: 'none',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'cascador',
        en: 'Cascador',
        zh: '瀑布兽',
        flavorEn: 'Falls upward when it gets excited, which is most of the time.',
        flavorZh: '一激动就往上流，而它几乎一直很激动。',
        art: {
          shape: 'serpent',
          eyes: 'star',
          crown: 'fin',
          tail: 'none',
          pattern: 'swirl',
          texture: 'scales',
          ears: 'frill',
          wings: 'none',
          aura: 'none',
        },
      },
      {
        id: 'maelstrix',
        en: 'Maelstrix',
        zh: '漩涡王',
        flavorEn: 'The whirlpool is not where it lives. The whirlpool is what it is.',
        flavorZh: '漩涡不是它住的地方，漩涡就是它本身。',
        art: {
          shape: 'serpent',
          eyes: 'fierce',
          crown: 'crystal',
          tail: 'none',
          pattern: 'plates',
          texture: 'scales',
          ears: 'frill',
          wings: 'none',
          aura: 'bubbles',
        },
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
        lineId: line.id,
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

/** The stage-1 creatures a new trainer chooses their first partner from. */
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

/**
 * Walks the evolution line from any member back to its stage-1 root.
 *
 * Keyed on `lineId`, not on element. With two lines sharing an element, finding
 * the root by element would send every ember creature down the same line and
 * quietly evolve a Cinderpup into a Blazur.
 */
export function evolutionLine(id: string): Creature[] {
  const target = getCreature(id);
  const root = CREATURES.find((c) => c.stage === 1 && c.lineId === target.lineId);
  if (!root) throw new Error(`No stage-1 creature for line ${target.lineId}`);

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

/** How many evolution lines each element carries. */
export const LINES_PER_ELEMENT = 2;

/** Sanity guard: the roster must stay a whole number of complete lines. */
export function rosterIsComplete(): boolean {
  return ELEMENTS.every((element) => {
    const lines = new Map<string, Creature[]>();
    for (const creature of creaturesByElement(element)) {
      const existing = lines.get(creature.lineId) ?? [];
      existing.push(creature);
      lines.set(creature.lineId, existing);
    }
    if (lines.size !== LINES_PER_ELEMENT) return false;

    return [...lines.values()].every(
      (line) =>
        line.length === 3 &&
        line
          .map((c) => c.stage)
          .sort()
          .join(',') === '1,2,3',
    );
  });
}
