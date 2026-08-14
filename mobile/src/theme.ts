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
  /**
   * The quiet label colour. It used to be `#64748b` - slate-500 - which is the
   * same colour, and the same mistake, the web client was carrying in thirteen
   * places. `mobile/scripts/audit_contrast_ios.py` measured it at 2.99:1 on a
   * frost-tinted opponent card, 3.28:1 on a locked badge and 3.55:1 on a plain
   * panel, against the 4.5:1 that normal text owes a child reading in a sunlit
   * car. This is the darkest grey that still clears 4.5:1 on every surface it
   * is used on with room to spare, so it stays quieter than `muted` without
   * becoming decoration.
   */
  faint: '#8a97aa',
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

/**
 * Blends `hex` into `base` by `weight` and returns an **opaque** `#rrggbb`.
 *
 * The difference from `tint` is the whole point. A translucent tint takes its
 * lightness from whatever it was dropped onto, so a surface built with `tint`
 * is a different colour on a plain panel than on an element-glowed one - and
 * when the label written on it is the very colour doing the tinting, as an
 * element chip's is, the contrast moves with it. The same Stone chip measured
 * 4.39:1 on the app background and 2.95:1 on the frost-glowed album card.
 *
 * Mixing to an opaque colour instead makes a chip read identically everywhere,
 * which is what lets `audit_contrast_ios.py` prove all six elements clear
 * 4.5:1 once rather than argue about it per screen. The web client's
 * `ElementChip` reaches the same place with `color-mix(in srgb, … 12%,
 * var(--color-ink))`; this is that, in a language without `color-mix`.
 */
export function mix(hex: string, weight: number, base: string): string {
  const w = Math.min(1, Math.max(0, weight));
  const channel = (at: number) => {
    const top = parseInt(hex.slice(at, at + 2), 16);
    const bottom = parseInt(base.slice(at, at + 2), 16);
    return Math.round(top * w + bottom * (1 - w))
      .toString(16)
      .padStart(2, '0');
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}
