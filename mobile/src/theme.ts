/**
 * Design tokens.
 *
 * Mirrors the web app's palette so the two clients look like one product. The
 * numbers are deliberately generous: the player is seven and playing on a
 * phone, so nothing tappable is smaller than TAP and body text never drops
 * below 14.
 */

export const colors = {
  bg: '#0b1120',
  panel: '#131c33',
  panelEdge: '#223052',
  text: '#ffffff',
  muted: '#94a3b8',
  faint: '#64748b',
  good: '#34d399',
  bad: '#fb7185',
  gold: '#fbbf24',
  sky: '#38bdf8',
  ink: '#1c2333',
} as const;

/**
 * Minimum tap target. Apple's own guidance is 44pt; a seven-year-old's aim is
 * worse than an adult's, so the web app uses 56 and this matches it.
 */
export const TAP = 56;

export const radius = { sm: 10, md: 16, lg: 22, pill: 999 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;

/** Adds alpha to a #rrggbb colour. Used for the element-tinted panels. */
export function tint(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex}${a}`;
}
