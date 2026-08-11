import type { Language } from './game/progress';

/**
 * Translations.
 *
 * The player is a bilingual seven-year-old, so English and Chinese are
 * first-class rather than one being a bolt-on. Keeping every string in one
 * table means a missing translation is a type error, not a surprise at
 * runtime.
 */

export type Phrase = { en: string; zh: string };

export const STRINGS = {
  appName: { en: 'Mathmon Battle League', zh: '数学宝贝对战联盟' },
  appShort: { en: 'Mathmon', zh: '数学宝贝' },
  tagline: {
    en: 'Catch monsters. Win battles. Get faster at maths.',
    zh: '收集伙伴，赢得战斗，数学越来越快。',
  },

  // Onboarding
  chooseName: { en: "What's your trainer name?", zh: '你的训练家名字是？' },
  namePlaceholder: { en: 'Type your name', zh: '输入名字' },
  choosePartner: { en: 'Choose your first partner', zh: '选择你的第一个伙伴' },
  startAdventure: { en: "Let's go!", zh: '出发！' },
  next: { en: 'Next', zh: '下一步' },
  back: { en: 'Back', zh: '返回' },

  // Dashboard
  hello: { en: 'Hello', zh: '你好' },
  battle: { en: 'Battle', zh: '战斗' },
  battleSub: { en: 'Find a wild creature', zh: '寻找野生伙伴' },
  album: { en: 'Album', zh: '图鉴' },
  albumSub: { en: 'See what you caught', zh: '查看你的收藏' },
  progress: { en: 'Progress', zh: '成长记录' },
  progressSub: { en: 'Badges and maths stats', zh: '徽章与数学统计' },
  level: { en: 'Level', zh: '等级' },
  mathLevel: { en: 'Maths level', zh: '数学等级' },
  streak: { en: 'Day streak', zh: '连续天数' },
  caught: { en: 'Caught', zh: '已收集' },
  partner: { en: 'Your partner', zh: '你的伙伴' },
  evolvesAt: { en: 'Evolves at level', zh: '进化等级' },
  finalForm: { en: 'Final form', zh: '最终形态' },

  // Battle
  chooseMove: { en: 'Pick your move', zh: '选择招式' },
  yourTurn: { en: 'Your turn', zh: '轮到你了' },
  charge: { en: 'Charge', zh: '能量' },
  combo: { en: 'Combo', zh: '连击' },
  answer: { en: 'Answer', zh: '答案' },
  submit: { en: 'Go!', zh: '确定！' },
  clear: { en: 'Clear', zh: '清除' },
  correct: { en: 'Correct!', zh: '答对了！' },
  wrong: { en: 'Not quite', zh: '差一点' },
  theAnswerWas: { en: 'The answer was', zh: '正确答案是' },
  superEffective: { en: 'Super effective!', zh: '效果拔群！' },
  notVeryEffective: { en: 'Not very effective', zh: '效果不佳' },
  critical: { en: 'Critical hit!', zh: '会心一击！' },
  continue: { en: 'Continue', zh: '继续' },
  wildAppeared: { en: 'A wild creature appeared!', zh: '出现了野生伙伴！' },
  catchIt: { en: 'Catch it!', zh: '抓住它！' },
  catchPrompt: { en: 'Solve this to catch it', zh: '答对就能抓住它' },
  youWin: { en: 'You win!', zh: '你赢了！' },
  youLost: { en: 'You fainted', zh: '你倒下了' },
  gotIt: { en: 'Caught it!', zh: '抓到了！' },
  itEscaped: { en: 'It got away', zh: '它逃走了' },
  xpEarned: { en: 'XP earned', zh: '获得经验' },
  levelUp: { en: 'Level up!', zh: '升级了！' },
  evolvedInto: { en: 'evolved into', zh: '进化成了' },
  newBadge: { en: 'New badge!', zh: '获得新徽章！' },
  mathLevelUp: { en: 'Maths level up!', zh: '数学等级提升！' },
  playAgain: { en: 'Battle again', zh: '再战一场' },
  goHome: { en: 'Home', zh: '主页' },
  accuracy: { en: 'Accuracy', zh: '正确率' },
  bestCombo: { en: 'Best combo', zh: '最高连击' },

  // Opponent picking
  pickOpponent: { en: 'Choose your opponent', zh: '选择对手' },
  pickOpponentSub: {
    en: 'Check the type chart. A good matchup makes the fight much easier.',
    zh: '看看属性表，选对克制关系会轻松很多。',
  },
  typeChart: { en: 'Type chart', zh: '属性相克表' },
  strongAgainst: { en: 'Strong against', zh: '克制' },
  weakTo: { en: 'Weak to', zh: '被克制' },
  yourType: { en: 'You', zh: '你' },
  goodMatchup: { en: 'Good matchup', zh: '优势对局' },
  badMatchup: { en: 'Tough matchup', zh: '劣势对局' },
  evenMatchup: { en: 'Even matchup', zh: '势均力敌' },

  // Album
  albumTitle: { en: 'Creature album', zh: '伙伴图鉴' },
  notCaughtYet: { en: 'Not caught yet', zh: '尚未收集' },
  stage: { en: 'Stage', zh: '阶段' },

  // Progress / stats
  progressTitle: { en: 'Your progress', zh: '你的成长' },
  badges: { en: 'Badges', zh: '徽章' },
  mathsBreakdown: { en: 'Maths skills', zh: '数学能力' },
  battlesWon: { en: 'Battles won', zh: '获胜场次' },
  questionsAnswered: { en: 'Questions answered', zh: '答题总数' },
  avgTime: { en: 'Average time', zh: '平均用时' },
  noDataYet: { en: 'Play a battle to see your stats.', zh: '战斗之后就能看到统计了。' },
  seconds: { en: 's', zh: '秒' },
  locked: { en: 'Locked', zh: '未解锁' },

  // Auth
  signIn: { en: 'Sign in', zh: '登录' },
  signOut: { en: 'Sign out', zh: '退出' },
  signInToSave: { en: 'Sign in to save', zh: '登录以保存' },
  signInBlurb: {
    en: 'Sign in so your album follows you to any device.',
    zh: '登录后，你的图鉴可以在任何设备上继续。',
  },
  continueWithGoogle: { en: 'Continue with Google', zh: '使用 Google 登录' },
  orUsePin: { en: 'or use a name and PIN', zh: '或使用名字和 PIN' },
  pin: { en: '4-digit PIN', zh: '4位数字密码' },
  pinHint: { en: 'Pick four numbers you can remember', zh: '选四个你能记住的数字' },
  createAccount: { en: 'Create account', zh: '创建账号' },
  haveAccount: { en: 'I already have an account', zh: '我已有账号' },
  needAccount: { en: 'Create a new account', zh: '创建新账号' },
  playWithoutAccount: { en: 'Just play (saves on this device)', zh: '直接玩（保存在本设备）' },
  savedLocally: { en: 'Saving on this device', zh: '保存在本设备' },
  savedToAccount: { en: 'Saved to your account', zh: '已保存到账号' },
  syncing: { en: 'Saving…', zh: '保存中…' },

  // Errors
  nameTooShort: { en: 'Please type at least 2 letters', zh: '请输入至少2个字符' },
  pinFourDigits: { en: 'PIN must be 4 digits', zh: 'PIN 必须是4位数字' },
  wrongPin: { en: 'That name and PIN do not match', zh: '名字和 PIN 不匹配' },
  nameTaken: { en: 'That name is taken - try another', zh: '这个名字已被使用，换一个吧' },
  somethingWentWrong: { en: 'Something went wrong. Try again.', zh: '出错了，请重试。' },

  // Settings
  settings: { en: 'Settings', zh: '设置' },
  sound: { en: 'Sound', zh: '声音' },
  language: { en: 'Language', zh: '语言' },
  on: { en: 'On', zh: '开' },
  off: { en: 'Off', zh: '关' },
} as const;

export type StringKey = keyof typeof STRINGS;

export function t(key: StringKey, language: Language): string {
  return STRINGS[key][language];
}

/** Reads a `{ en, zh }` pair from game data. */
export function localise(phrase: Phrase, language: Language): string {
  return phrase[language];
}
