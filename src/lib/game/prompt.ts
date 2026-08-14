/**
 * How wide a maths prompt is, and how large it may be drawn.
 *
 * Shared for the same reason `art.ts` is shared: it is a model, not a picture.
 * This module knows nothing about CSS, points, `StyleSheet` or the DOM - it
 * answers "how many ems wide is this string" and "what size may it be drawn at
 * to fit a line box of N units", and each client supplies the two facts only it
 * knows: how big the prompt is normally, and how wide its own line box is.
 *
 * Why it exists
 * -------------
 * The prompt used to render at one fixed size on each client. That was fine
 * while the longest question in the game was `(9 × 9) + 20` at twelve
 * characters. The chess strand made the longest `(♛9 + ♜5) − (♝3 + ♟1)` - 21
 * characters, four of them chess glyphs, which are nearly twice the advance of
 * a digit - and it wrapped onto two lines on every phone, including a roomy
 * one. `(♛9 + ♜5) −` above `(♝3 + ♟1)` is not the question the engine asked,
 * and the speed meter is draining while a seven-year-old works out what he is
 * looking at.
 *
 * The rule is driven by the prompt itself, never by which skill produced it. A
 * skill added next year will have a length and a set of glyphs, and nobody will
 * remember to add it to a list.
 *
 * Why a width model rather than a character count
 * -----------------------------------------------
 * `(♛9 + ♜5) − (♝3 + ♟1)` and `? = 18 + 999999999 + 1` are both 21 characters
 * and are not the same width. Counting characters would either shrink the
 * digit-only prompt for no reason or leave the chess one overflowing. So each
 * character contributes its own advance, and the sum is the answer.
 */

/**
 * Advance width of one character, in ems, by class.
 *
 * Measured in the app's own type stack at font-weight 900 and rounded **up**,
 * because this number is used to decide whether something fits: overestimating
 * costs a couple of points of type size, and underestimating costs the child
 * his question. The measured values were 0.348 (space), 0.457 (bracket), 0.580
 * (`?`), 0.696 (digit), 0.838 (operator), 0.897 (chess), 1.035 (vulgar
 * fraction).
 *
 * Summing per-character advances also ignores kerning, which only ever pulls a
 * line in: the real `(♛9 + ♜5) − (♝3 + ♟1)` measured 12.80em against a sum of
 * 13.50em with the values above. That slack is the headroom for a device whose
 * fallback font is a little wider than the one this was measured in.
 */
export const PROMPT_EM = {
  space: 0.36,
  bracket: 0.48,
  question: 0.6,
  digit: 0.72,
  letter: 0.72,
  operator: 0.86,
  chess: 0.92,
  fraction: 1.06,
  /**
   * Anything this module has never seen. Deliberately the widest entry: a new
   * glyph that nobody thought about should make the prompt smaller and legible
   * rather than wider and cut off.
   */
  other: 1.1,
} as const;

/** The glyphs `math.ts` builds prompts out of, grouped by advance. */
const BRACKETS = '()';
const OPERATORS = '+−×÷=';
const CHESS = '♟♞♝♜♛';
const FRACTIONS = '½⅓¼';

function advanceEm(character: string): number {
  if (character === ' ') return PROMPT_EM.space;
  if (character === '?') return PROMPT_EM.question;
  if (character >= '0' && character <= '9') return PROMPT_EM.digit;
  if (BRACKETS.includes(character)) return PROMPT_EM.bracket;
  if (OPERATORS.includes(character)) return PROMPT_EM.operator;
  if (CHESS.includes(character)) return PROMPT_EM.chess;
  if (FRACTIONS.includes(character)) return PROMPT_EM.fraction;
  // `½ of 24` is the only prompt shape with words in it today.
  if (/[A-Za-z]/.test(character)) return PROMPT_EM.letter;
  return PROMPT_EM.other;
}

/**
 * How wide `prompt` is when drawn at font size 1, in ems.
 *
 * Iterated by code point rather than by UTF-16 unit so an astral glyph counts
 * once. The chess pieces are in the BMP, but the next symbol somebody reaches
 * for might not be.
 */
export function promptWidthEm(prompt: string): number {
  let width = 0;
  for (const character of prompt) width += advanceEm(character);
  return width;
}

/**
 * The largest size `prompt` may be drawn at to stay on one line.
 *
 * Every unit here is the caller's own - CSS pixels on the web, points on iOS -
 * and this function never converts between them. It only ever divides a line
 * box by a width in ems, so it is unit-agnostic by construction.
 *
 * `min` is a floor, not a target: it exists so a pathological prompt renders
 * small rather than microscopic, and `scripts/audit_prompt_fit.py` fails the
 * build if any prompt the generator can actually produce reaches it, because at
 * that point the floor is no longer protecting legibility - it is causing the
 * overflow it was meant to prevent.
 */
export function promptFontSize(
  prompt: string,
  size: { full: number; min: number; lineBox: number },
): number {
  const fits = size.lineBox / promptWidthEm(prompt);
  return Math.max(size.min, Math.min(size.full, fits));
}
