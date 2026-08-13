import type { ArtSpec, Creature } from './creatures';

/**
 * The creature renderer, as data.
 *
 * Every creature in the game is drawn from its `ArtSpec` rather than loaded as
 * an image. That is not a shortcut - it is what makes the roster free to grow.
 * Thirty-six creatures cost about sixty kilobytes of geometry (measured by
 * `scripts/audit_assets.py`, so this number stays honest), no image
 * requests, no third-party sprites, no licence to track, and they stay sharp at
 * any size on any screen.
 *
 * This module emits a `Drawing`: a list of primitive shapes and the gradients
 * they reference. It knows nothing about SVG, the DOM or React Native. Each
 * client has a small renderer that maps a primitive onto its own drawing
 * surface - a 45-line switch on each side.
 *
 * That split exists because the geometry used to be written out twice, once per
 * client, and hand-ported between them. A creature could quietly lose its crown
 * on one platform and nobody would notice, because a missing branch renders as
 * nothing and nothing looks like art. Now there is one copy and two dumb
 * renderers.
 */

// ---------------------------------------------------------------------------
// The drawing model
// ---------------------------------------------------------------------------

export type Paint = {
  /** A `#rrggbb` colour, or `grad:<id>` to reference a gradient. */
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
  strokeLinecap?: 'round' | 'butt';
  opacity?: number;
};

export type Shape =
  | ({ kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotate?: number } & Paint)
  | ({ kind: 'circle'; cx: number; cy: number; r: number } & Paint)
  | ({ kind: 'path'; d: string } & Paint)
  | ({ kind: 'rect'; x: number; y: number; width: number; height: number; rx?: number } & Paint)
  | { kind: 'group'; transform?: string; opacity?: number; children: Shape[] };

export type GradientStop = { offset: string; color: string; opacity?: number };

export type Gradient = {
  id: string;
  cx: string;
  cy: string;
  r: string;
  stops: GradientStop[];
};

export type Drawing = {
  viewBox: string;
  gradients: Gradient[];
  shapes: Shape[];
};

/** Prefix marking a `fill` as a gradient reference rather than a colour. */
export const GRADIENT_REF = 'grad:';

export const VIEW_BOX = '0 0 100 100';

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function clamp8(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/**
 * Shifts a `#rrggbb` colour towards black or white.
 *
 * Shading is derived from each creature's own palette rather than painted with
 * a fixed grey, so a frost creature's underside stays blue and an ember
 * creature's stays warm. Mixing in grey instead made every creature look dusty.
 */
export function shade(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;

  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return hex;

  const target = amount < 0 ? 0 : 255;
  const t = Math.abs(amount);
  const mix = (channel: number) => clamp8(channel + (target - channel) * t);

  return `#${[mix(r), mix(g), mix(b)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

// ---------------------------------------------------------------------------
// Silhouettes
// ---------------------------------------------------------------------------

/**
 * A body outline plus the ellipse inscribed in it.
 *
 * Patterns, textures and faces are placed against the inscribed ellipse, so a
 * new body shape gets all of them positioned correctly by declaring its own
 * centre and radii rather than by every feature growing another special case.
 */
type Silhouette = {
  draw: (paint: Paint, dy?: number) => Shape;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  /** Where the face sits. Serpents carry their head higher than blobs. */
  faceY: number;
  /**
   * Radius of the head the face is drawn on.
   *
   * Eyes, mouth and cheeks are all derived from this rather than from the body
   * radius. A coiled serpent's head is half the width of its coil, and sizing
   * its face off the body gave it cheeks wider than its own head.
   */
  faceR: number;
};

const SPIKY_POINTS = 11;

function silhouetteFor(spec: ArtSpec): Silhouette {
  switch (spec.shape) {
    case 'round':
      return {
        cx: 50,
        cy: 58,
        rx: 31,
        ry: 29,
        faceY: 50,
        faceR: 18,
        draw: (paint, dy = 0) => ({
          kind: 'ellipse',
          cx: 50,
          cy: 58 + dy,
          rx: 31,
          ry: 29,
          ...paint,
        }),
      };

    case 'tall':
      return {
        cx: 50,
        cy: 54,
        rx: 25,
        ry: 35,
        faceY: 44,
        faceR: 16,
        draw: (paint, dy = 0) => ({
          kind: 'ellipse',
          cx: 50,
          cy: 54 + dy,
          rx: 25,
          ry: 35,
          ...paint,
        }),
      };

    case 'blob':
      return {
        cx: 50,
        cy: 58,
        rx: 31,
        ry: 29,
        faceY: 50,
        faceR: 18,
        draw: (paint, dy = 0) => ({
          kind: 'path',
          d: `M50 ${24 + dy} C28 ${24 + dy} 19 ${42 + dy} 19 ${58 + dy} C19 ${78 + dy} 33 ${88 + dy} 50 ${88 + dy} C67 ${88 + dy} 81 ${78 + dy} 81 ${58 + dy} C81 ${42 + dy} 72 ${24 + dy} 50 ${24 + dy} Z`,
          ...paint,
        }),
      };

    case 'spiky':
      return {
        cx: 50,
        cy: 58,
        rx: 30,
        ry: 29,
        faceY: 50,
        faceR: 18,
        draw: (paint, dy = 0) => ({
          kind: 'group',
          children: [
            ...Array.from({ length: SPIKY_POINTS }, (_, i): Shape => {
              const angle = (i / SPIKY_POINTS) * Math.PI * 2 - Math.PI / 2;
              const x = 50 + Math.cos(angle) * 29;
              const y = 58 + dy + Math.sin(angle) * 28;
              const tipX = 50 + Math.cos(angle) * 42;
              const tipY = 58 + dy + Math.sin(angle) * 40;
              const sx = 50 + Math.cos(angle + 0.26) * 29;
              const sy = 58 + dy + Math.sin(angle + 0.26) * 28;
              return { kind: 'path', d: `M${x} ${y} L${tipX} ${tipY} L${sx} ${sy} Z`, ...paint };
            }),
            { kind: 'ellipse', cx: 50, cy: 58 + dy, rx: 30, ry: 29, ...paint },
          ],
        }),
      };

    case 'serpent':
      // Drawn as a thick round-capped stroke rather than a filled outline: a
      // coil reads as a coil when the width is constant, and a filled path of
      // the same shape turns into a puddle at the bends.
      return {
        cx: 50,
        cy: 62,
        rx: 22,
        ry: 20,
        faceY: 36,
        faceR: 11,
        draw: (paint, dy = 0) => ({
          kind: 'path',
          d: `M50 ${34 + dy} C30 ${34 + dy} 24 ${52 + dy} 40 ${58 + dy} C58 ${65 + dy} 74 ${62 + dy} 72 ${74 + dy} C70 ${85 + dy} 46 ${88 + dy} 32 ${80 + dy}`,
          fill: 'none',
          stroke: paint.fill ?? paint.stroke,
          strokeWidth: 23,
          strokeLinecap: 'round',
          opacity: paint.opacity,
        }),
      };

    case 'beast':
      return {
        cx: 50,
        cy: 60,
        rx: 27,
        ry: 21,
        faceY: 46,
        faceR: 16,
        draw: (paint, dy = 0) => ({
          kind: 'path',
          d: `M23 ${60 + dy} C23 ${44 + dy} 36 ${38 + dy} 50 ${38 + dy} C64 ${38 + dy} 77 ${44 + dy} 77 ${60 + dy} C77 ${74 + dy} 66 ${81 + dy} 50 ${81 + dy} C34 ${81 + dy} 23 ${74 + dy} 23 ${60 + dy} Z`,
          ...paint,
        }),
      };

    default:
      return {
        cx: 50,
        cy: 58,
        rx: 30,
        ry: 29,
        faceY: 50,
        faceR: 18,
        draw: (paint, dy = 0) => ({
          kind: 'ellipse',
          cx: 50,
          cy: 58 + dy,
          rx: 30,
          ry: 29,
          ...paint,
        }),
      };
  }
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function crown(spec: ArtSpec): Shape[] {
  const { accent } = spec;
  const fill = { fill: accent };

  switch (spec.crown) {
    case 'flame':
      return [
        {
          kind: 'path',
          d: 'M50 4 C56 14 64 18 62 26 C60 33 52 34 50 34 C48 34 40 33 38 26 C36 18 44 14 50 4 Z',
          ...fill,
        },
        {
          kind: 'path',
          d: 'M50 14 C53 20 56 22 55 26 C54 30 51 30 50 30 C49 30 46 30 45 26 C44 22 47 20 50 14 Z',
          fill: '#fff4d6',
        },
      ];

    case 'leaf':
      return [
        { kind: 'path', d: 'M50 30 C50 18 42 10 34 10 C34 20 40 29 50 30 Z', ...fill },
        { kind: 'path', d: 'M50 30 C50 18 58 10 66 10 C66 20 60 29 50 30 Z', ...fill },
        { kind: 'rect', x: 48.5, y: 26, width: 3, height: 8, rx: 1.5, fill: '#7a5c2e' },
      ];

    case 'crystal':
      return [
        { kind: 'path', d: 'M50 2 L57 22 L43 22 Z', ...fill, opacity: 0.95 },
        { kind: 'path', d: 'M35 12 L41 26 L29 26 Z', ...fill, opacity: 0.95 },
        { kind: 'path', d: 'M65 12 L71 26 L59 26 Z', ...fill, opacity: 0.95 },
        { kind: 'path', d: 'M50 6 L54 20 L46 20 Z', fill: shade(accent, 0.5), opacity: 0.7 },
      ];

    case 'bolt':
      return [
        { kind: 'path', d: 'M54 2 L38 22 L48 22 L44 36 L62 15 L51 15 Z', ...fill },
        {
          kind: 'path',
          d: 'M53 8 L44 20 L50 20 L48 29 L57 17 L50 17 Z',
          fill: '#fffbe6',
          opacity: 0.8,
        },
      ];

    case 'rock':
      return [
        { kind: 'path', d: 'M36 26 L42 12 L50 24 Z', ...fill },
        { kind: 'path', d: 'M48 24 L57 10 L66 26 Z', ...fill },
        { kind: 'path', d: 'M50 24 L57 14 L60 24 Z', fill: shade(accent, -0.25) },
      ];

    case 'fin':
      return [
        {
          kind: 'path',
          d: 'M50 2 C58 12 62 20 60 30 L40 30 C38 20 42 12 50 2 Z',
          ...fill,
          opacity: 0.92,
        },
        {
          kind: 'path',
          d: 'M50 8 L50 30',
          stroke: shade(accent, -0.3),
          strokeWidth: 1.6,
          fill: 'none',
        },
      ];

    case 'horn':
      return [
        { kind: 'path', d: 'M34 30 C30 20 32 12 38 8 C40 16 42 24 44 30 Z', ...fill },
        { kind: 'path', d: 'M66 30 C70 20 68 12 62 8 C60 16 58 24 56 30 Z', ...fill },
      ];

    case 'antler':
      return [
        {
          kind: 'path',
          d: 'M40 28 C36 18 34 12 30 6 M36 16 L26 12 M38 22 L28 21',
          stroke: accent,
          strokeWidth: 3,
          strokeLinecap: 'round',
          fill: 'none',
        },
        {
          kind: 'path',
          d: 'M60 28 C64 18 66 12 70 6 M64 16 L74 12 M62 22 L72 21',
          stroke: accent,
          strokeWidth: 3,
          strokeLinecap: 'round',
          fill: 'none',
        },
      ];

    case 'plume':
      return [
        { kind: 'ellipse', cx: 50, cy: 16, rx: 5, ry: 14, ...fill },
        { kind: 'ellipse', cx: 40, cy: 21, rx: 4, ry: 11, ...fill, rotate: -22, opacity: 0.85 },
        { kind: 'ellipse', cx: 60, cy: 21, rx: 4, ry: 11, ...fill, rotate: 22, opacity: 0.85 },
      ];

    default:
      return [];
  }
}

function ears(spec: ArtSpec, body: Silhouette): Shape[] {
  const y = body.faceY - 16;
  const dx = body.rx - 8;
  const fill = { fill: spec.primary };
  const inner = { fill: shade(spec.accent, 0.35) };

  switch (spec.ears) {
    case 'round':
      return [
        { kind: 'circle', cx: 50 - dx, cy: y, r: 9, ...fill },
        { kind: 'circle', cx: 50 + dx, cy: y, r: 9, ...fill },
        { kind: 'circle', cx: 50 - dx, cy: y, r: 4.5, ...inner },
        { kind: 'circle', cx: 50 + dx, cy: y, r: 4.5, ...inner },
      ];

    case 'pointed':
      return [
        {
          kind: 'path',
          d: `M${50 - dx - 7} ${y + 9} L${50 - dx - 1} ${y - 12} L${50 - dx + 6} ${y + 7} Z`,
          ...fill,
        },
        {
          kind: 'path',
          d: `M${50 + dx + 7} ${y + 9} L${50 + dx + 1} ${y - 12} L${50 + dx - 6} ${y + 7} Z`,
          ...fill,
        },
      ];

    case 'long':
      return [
        { kind: 'ellipse', cx: 50 - dx + 2, cy: y - 8, rx: 5, ry: 15, ...fill, rotate: -12 },
        { kind: 'ellipse', cx: 50 + dx - 2, cy: y - 8, rx: 5, ry: 15, ...fill, rotate: 12 },
      ];

    case 'frill':
      return [
        {
          kind: 'path',
          d: `M${50 - dx - 4} ${y + 12} C${50 - dx - 14} ${y} ${50 - dx - 10} ${y - 10} ${50 - dx + 2} ${y - 6} Z`,
          fill: spec.accent,
          opacity: 0.9,
        },
        {
          kind: 'path',
          d: `M${50 + dx + 4} ${y + 12} C${50 + dx + 14} ${y} ${50 + dx + 10} ${y - 10} ${50 + dx - 2} ${y - 6} Z`,
          fill: spec.accent,
          opacity: 0.9,
        },
      ];

    default:
      return [];
  }
}

/** Drawn behind the body, so they read as depth rather than as stickers. */
function wings(spec: ArtSpec): Shape[] {
  switch (spec.wings) {
    case 'membrane':
      return [
        {
          kind: 'path',
          d: 'M32 48 C10 36 4 54 12 66 C18 76 30 72 34 64 Z',
          fill: shade(spec.primary, -0.15),
          opacity: 0.9,
        },
        {
          kind: 'path',
          d: 'M68 48 C90 36 96 54 88 66 C82 76 70 72 66 64 Z',
          fill: shade(spec.primary, -0.15),
          opacity: 0.9,
        },
      ];

    case 'feather':
      return [
        {
          kind: 'path',
          d: 'M33 46 C14 38 2 50 8 62 C14 74 30 70 36 60 Z',
          fill: shade(spec.secondary, -0.1),
        },
        {
          kind: 'path',
          d: 'M67 46 C86 38 98 50 92 62 C86 74 70 70 64 60 Z',
          fill: shade(spec.secondary, -0.1),
        },
        {
          kind: 'path',
          d: 'M30 50 L14 56 M32 57 L16 63',
          stroke: shade(spec.accent, -0.2),
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          fill: 'none',
        },
        {
          kind: 'path',
          d: 'M70 50 L86 56 M68 57 L84 63',
          stroke: shade(spec.accent, -0.2),
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          fill: 'none',
        },
      ];

    case 'insect':
      // Tinted from the accent rather than the near-white secondary, which
      // rendered as four grey smudges against the dark battle background.
      return [
        {
          kind: 'ellipse',
          cx: 24,
          cy: 44,
          rx: 17,
          ry: 10,
          fill: spec.accent,
          opacity: 0.7,
          rotate: -30,
        },
        {
          kind: 'ellipse',
          cx: 76,
          cy: 44,
          rx: 17,
          ry: 10,
          fill: spec.accent,
          opacity: 0.7,
          rotate: 30,
        },
        {
          kind: 'ellipse',
          cx: 28,
          cy: 60,
          rx: 13,
          ry: 8,
          fill: shade(spec.accent, 0.3),
          opacity: 0.6,
          rotate: -12,
        },
        {
          kind: 'ellipse',
          cx: 72,
          cy: 60,
          rx: 13,
          ry: 8,
          fill: shade(spec.accent, 0.3),
          opacity: 0.6,
          rotate: 12,
        },
        {
          kind: 'path',
          d: 'M34 46 L14 42 M32 59 L18 62',
          stroke: shade(spec.accent, -0.35),
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          fill: 'none',
          opacity: 0.7,
        },
        {
          kind: 'path',
          d: 'M66 46 L86 42 M68 59 L82 62',
          stroke: shade(spec.accent, -0.35),
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          fill: 'none',
          opacity: 0.7,
        },
      ];

    default:
      return [];
  }
}

function tail(spec: ArtSpec): Shape[] {
  switch (spec.tail) {
    case 'puff':
      return [
        { kind: 'circle', cx: 88, cy: 68, r: 10, fill: spec.primary },
        { kind: 'circle', cx: 90, cy: 65, r: 5, fill: shade(spec.secondary, 0.2), opacity: 0.7 },
      ];

    case 'blade':
      return [
        { kind: 'path', d: 'M76 62 L98 48 L94 74 Z', fill: spec.accent },
        { kind: 'path', d: 'M80 62 L94 53 L92 68 Z', fill: shade(spec.accent, 0.35), opacity: 0.7 },
      ];

    case 'curl':
      return [
        {
          kind: 'path',
          // Starts clear of the right arm so the two do not merge into a blob.
          d: 'M80 72 C96 74 102 60 93 53 C88 49 82 52 83 58',
          stroke: spec.primary,
          strokeWidth: 7,
          strokeLinecap: 'round',
          fill: 'none',
        },
      ];

    case 'spark':
      return [
        { kind: 'path', d: 'M76 66 L92 58 L84 68 L98 62 L82 78 L86 68 Z', fill: spec.accent },
      ];

    case 'fan':
      // Tucked in against the body. Further out it stopped reading as a tail
      // and started reading as a detached shield floating beside the creature.
      return [
        {
          kind: 'ellipse',
          cx: 80,
          cy: 66,
          rx: 7,
          ry: 14,
          fill: spec.accent,
          rotate: 28,
          opacity: 0.9,
        },
        {
          kind: 'ellipse',
          cx: 86,
          cy: 72,
          rx: 5.5,
          ry: 11,
          fill: shade(spec.accent, 0.3),
          rotate: 44,
          opacity: 0.8,
        },
      ];

    case 'lash':
      return [
        {
          kind: 'path',
          d: 'M76 68 C88 66 96 74 92 82',
          stroke: spec.primary,
          strokeWidth: 6,
          strokeLinecap: 'round',
          fill: 'none',
        },
        { kind: 'circle', cx: 92, cy: 83, r: 4, fill: spec.accent },
      ];

    default:
      return [];
  }
}

function pattern(spec: ArtSpec, body: Silhouette): Shape[] {
  const { cx, ry } = body;
  const belly = body.cy + ry * 0.34;

  switch (spec.pattern) {
    case 'belly':
      return [
        {
          kind: 'ellipse',
          cx,
          cy: belly,
          rx: body.rx * 0.62,
          ry: ry * 0.52,
          fill: spec.secondary,
          opacity: 0.85,
        },
      ];

    case 'spots':
      return [
        { kind: 'circle', cx: cx - 14, cy: belly, r: 5, fill: spec.accent, opacity: 0.55 },
        { kind: 'circle', cx: cx + 12, cy: belly + 4, r: 4, fill: spec.accent, opacity: 0.55 },
        { kind: 'circle', cx, cy: belly - 6, r: 3.2, fill: spec.accent, opacity: 0.55 },
      ];

    case 'stripes':
      return [
        {
          kind: 'path',
          d: `M${cx - 18} ${belly - 4} q 18 8 36 0`,
          stroke: spec.accent,
          strokeWidth: 4,
          strokeLinecap: 'round',
          fill: 'none',
          opacity: 0.6,
        },
        {
          kind: 'path',
          d: `M${cx - 16} ${belly + 6} q 16 7 32 0`,
          stroke: spec.accent,
          strokeWidth: 4,
          strokeLinecap: 'round',
          fill: 'none',
          opacity: 0.6,
        },
      ];

    case 'plates':
      return [0, 1, 2].map((i): Shape => ({
        kind: 'path',
        d: `M${cx - 16} ${belly - 8 + i * 9} q 16 6 32 0`,
        stroke: shade(spec.accent, -0.2),
        strokeWidth: 3,
        strokeLinecap: 'round',
        fill: 'none',
        opacity: 0.5,
      }));

    case 'swirl':
      return [
        {
          kind: 'path',
          d: `M${cx - 10} ${belly} c 0 -8 16 -8 16 0 c 0 6 -11 6 -11 0 c 0 -3 6 -3 6 0`,
          stroke: spec.secondary,
          strokeWidth: 3,
          strokeLinecap: 'round',
          fill: 'none',
          opacity: 0.75,
        },
      ];

    default:
      return [];
  }
}

/**
 * Surface detail.
 *
 * The single flat body fill is what made the earlier art read as a sticker.
 * These marks are deliberately sparse and low-contrast: enough to suggest fur
 * or scale at 64px in the album, not so much that it turns to noise.
 */
function texture(spec: ArtSpec, body: Silhouette): Shape[] {
  const { cx, cy, rx, ry } = body;
  const line = shade(spec.primary, -0.25);

  switch (spec.texture) {
    case 'fur':
      return Array.from({ length: 7 }, (_, i): Shape => {
        const t = (i / 6) * Math.PI;
        const x = cx - rx * 0.8 + (rx * 1.6 * i) / 6;
        const y = cy + ry * 0.55 * Math.sin(t) * 0.6 + ry * 0.2;
        return {
          kind: 'path',
          d: `M${x} ${y} l -2.5 5`,
          stroke: line,
          strokeWidth: 2,
          strokeLinecap: 'round',
          fill: 'none',
          opacity: 0.3,
        };
      });

    case 'scales':
      return Array.from({ length: 6 }, (_, i): Shape => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        return {
          kind: 'path',
          d: `M${cx - 14 + col * 14 - row * 6} ${cy - 4 + row * 10} q 6 6 12 0`,
          stroke: line,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          fill: 'none',
          opacity: 0.35,
        };
      });

    case 'crystal':
      return [
        {
          kind: 'path',
          d: `M${cx - 12} ${cy + 8} L${cx - 4} ${cy - 8} L${cx + 6} ${cy + 6} Z`,
          fill: '#ffffff',
          opacity: 0.16,
        },
        {
          kind: 'path',
          d: `M${cx + 4} ${cy + 12} L${cx + 12} ${cy - 4} L${cx + 18} ${cy + 10} Z`,
          fill: '#ffffff',
          opacity: 0.12,
        },
      ];

    case 'rocky':
      return [
        {
          kind: 'path',
          d: `M${cx - 16} ${cy} l 8 -6 l 7 5 l -6 6 Z`,
          fill: shade(spec.primary, -0.2),
          opacity: 0.5,
        },
        {
          kind: 'path',
          d: `M${cx + 4} ${cy + 8} l 9 -5 l 6 7 l -8 4 Z`,
          fill: shade(spec.primary, -0.2),
          opacity: 0.4,
        },
        {
          kind: 'path',
          d: `M${cx + 2} ${cy - 12} l 7 -4 l 4 6 l -7 3 Z`,
          fill: shade(spec.primary, 0.18),
          opacity: 0.35,
        },
      ];

    default:
      return [];
  }
}

function eyes(spec: ArtSpec, body: Silhouette): Shape[] {
  const y = body.faceY;
  const spread = body.faceR * 0.62;
  const left = 50 - spread;
  const right = 50 + spread;
  const scale = body.faceR / 18;

  if (spec.eyes === 'sleepy') {
    return [
      {
        kind: 'path',
        d: `M${left - 6} ${y} q 6 6 12 0 M${right - 6} ${y} q 6 6 12 0`,
        stroke: '#1c2333',
        strokeWidth: 3,
        strokeLinecap: 'round',
        fill: 'none',
      },
    ];
  }

  if (spec.eyes === 'visor') {
    // One band instead of two eyes. Used by the insect line, where a pair of
    // round eyes made it look like everything else on the roster.
    return [
      {
        kind: 'path',
        d: `M${left - 10} ${y - 4} q ${spread + 10} -7 ${2 * spread + 20} 0 q -${spread + 10} 13 -${2 * spread + 20} 0 Z`,
        fill: '#1c2333',
      },
      { kind: 'ellipse', cx: left - 2, cy: y - 2, rx: 4, ry: 2.4, fill: '#ffffff', opacity: 0.45 },
      { kind: 'ellipse', cx: right + 3, cy: y, rx: 2.6, ry: 1.6, fill: '#ffffff', opacity: 0.3 },
    ];
  }

  const pupil = spec.eyes === 'star' ? '#ffd23f' : '#1c2333';
  const radius = (spec.eyes === 'fierce' ? 6.5 : 7.5) * scale;

  const eye = (cx: number): Shape[] => [
    { kind: 'ellipse', cx, cy: y, rx: radius, ry: radius + 1, fill: '#ffffff' },
    ...(spec.eyes === 'star'
      ? [
          {
            kind: 'path' as const,
            d: `M${cx} ${y - 5} l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z`,
            fill: pupil,
          },
        ]
      : [
          { kind: 'circle' as const, cx, cy: y + 1, r: 3.6, fill: pupil },
          { kind: 'circle' as const, cx: cx + 1.4, cy: y - 1.4, r: 1.5, fill: '#ffffff' },
          {
            kind: 'circle' as const,
            cx: cx - 1.6,
            cy: y + 2.6,
            r: 0.9,
            fill: '#ffffff',
            opacity: 0.6,
          },
        ]),
  ];

  return [
    ...eye(left),
    ...eye(right),
    ...(spec.eyes === 'fierce'
      ? [
          {
            kind: 'path' as const,
            d: `M${left - 8} ${y - 9} l 13 4 M${right + 8} ${y - 9} l -13 4`,
            stroke: '#1c2333',
            strokeWidth: 3,
            strokeLinecap: 'round' as const,
            fill: 'none',
          },
        ]
      : []),
  ];
}

/** Ambient particles. Only final forms get them, so evolving visibly matters. */
function aura(spec: ArtSpec): Shape[] {
  const dots = (color: string, opacity: number): Shape[] =>
    [
      { x: 16, y: 30, r: 3 },
      { x: 84, y: 26, r: 2.2 },
      { x: 22, y: 76, r: 2 },
      { x: 88, y: 82, r: 2.6 },
      { x: 50, y: 12, r: 1.8 },
    ].map(({ x, y, r }) => ({ kind: 'circle', cx: x, cy: y, r, fill: color, opacity }));

  switch (spec.aura) {
    case 'embers':
      return dots(spec.accent, 0.75);
    case 'frost':
      return dots('#ffffff', 0.7);
    case 'leaves':
      return [
        {
          kind: 'ellipse',
          cx: 16,
          cy: 32,
          rx: 5,
          ry: 2.6,
          fill: spec.accent,
          opacity: 0.7,
          rotate: -25,
        },
        {
          kind: 'ellipse',
          cx: 85,
          cy: 70,
          rx: 5,
          ry: 2.6,
          fill: spec.accent,
          opacity: 0.7,
          rotate: 20,
        },
        {
          kind: 'ellipse',
          cx: 78,
          cy: 22,
          rx: 4,
          ry: 2.2,
          fill: spec.accent,
          opacity: 0.6,
          rotate: 40,
        },
      ];
    case 'dust':
      return dots(shade(spec.primary, -0.2), 0.5);
    case 'sparks':
      return [
        {
          kind: 'path',
          d: 'M14 30 l4 -6 l-1 5 l4 -1 l-6 7 l1 -5 Z',
          fill: spec.accent,
          opacity: 0.85,
        },
        {
          kind: 'path',
          d: 'M84 74 l4 -6 l-1 5 l4 -1 l-6 7 l1 -5 Z',
          fill: spec.accent,
          opacity: 0.75,
        },
      ];
    case 'bubbles':
      return [
        {
          kind: 'circle',
          cx: 18,
          cy: 34,
          r: 4,
          fill: 'none',
          stroke: '#ffffff',
          strokeWidth: 1.4,
          opacity: 0.6,
        },
        {
          kind: 'circle',
          cx: 84,
          cy: 28,
          r: 2.6,
          fill: 'none',
          stroke: '#ffffff',
          strokeWidth: 1.2,
          opacity: 0.5,
        },
        {
          kind: 'circle',
          cx: 80,
          cy: 78,
          r: 3.4,
          fill: 'none',
          stroke: '#ffffff',
          strokeWidth: 1.2,
          opacity: 0.5,
        },
      ];
    default:
      return [];
  }
}

/** Legs and arms, tucked against whichever silhouette this creature has. */
function limbs(spec: ArtSpec, body: Silhouette): Shape[] {
  const foot = { fill: shade(spec.accent, -0.1), opacity: 0.95 };

  // A coiled body ends in a tail, not in feet.
  if (spec.shape === 'serpent') return [];

  if (spec.shape === 'beast') {
    // Four legs, front pair lighter than the back pair. Two legs tucked under
    // the middle read as a ball with feet; splaying them to the shoulders and
    // hips is what makes the silhouette a quadruped at album size.
    const top = body.cy + body.ry - 6;
    const leg = (x: number, back: boolean): Shape[] => [
      {
        kind: 'rect',
        x,
        y: top,
        width: 10,
        height: 17,
        rx: 5,
        fill: shade(spec.primary, back ? -0.28 : -0.1),
      },
      { kind: 'ellipse', cx: x + 5, cy: top + 17, rx: 7, ry: 4.2, ...foot },
    ];

    return [...leg(26, true), ...leg(64, true), ...leg(34, false), ...leg(56, false)];
  }

  const armY = body.cy + 4;
  const armX = body.rx - 2;
  return [
    { kind: 'ellipse', cx: 50 - armX, cy: armY, rx: 7, ry: 9, fill: spec.primary, rotate: -18 },
    { kind: 'ellipse', cx: 50 + armX, cy: armY, rx: 7, ry: 9, fill: spec.primary, rotate: 18 },
    { kind: 'ellipse', cx: 38, cy: body.cy + body.ry - 2, rx: 9, ry: 6, ...foot },
    { kind: 'ellipse', cx: 62, cy: body.cy + body.ry - 2, rx: 9, ry: 6, ...foot },
  ];
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Compiles a creature into shapes.
 *
 * Draw order is back to front: aura, wings, tail, limbs, then the body with its
 * shading, then everything that sits on the face.
 */
export function drawCreature(creature: Creature, options: { silhouette?: boolean } = {}): Drawing {
  const spec = creature.art;
  const body = silhouetteFor(spec);

  const bodyGradient = `mm-${creature.id}-body`;
  const shadowGradient = `mm-${creature.id}-shadow`;

  const gradients: Gradient[] = [
    {
      id: bodyGradient,
      cx: '38%',
      cy: '28%',
      r: '80%',
      stops: options.silhouette
        ? [
            { offset: '0%', color: '#334155' },
            { offset: '60%', color: '#1e293b' },
            { offset: '100%', color: '#0f172a' },
          ]
        : [
            // Four stops rather than three: the extra highlight near the top is
            // what stops a large creature reading as one flat colour.
            { offset: '0%', color: shade(spec.secondary, 0.35) },
            { offset: '26%', color: spec.secondary },
            { offset: '62%', color: spec.primary },
            { offset: '100%', color: shade(spec.accent, -0.15) },
          ],
    },
    {
      id: shadowGradient,
      cx: '50%',
      cy: '50%',
      r: '50%',
      stops: [
        { offset: '0%', color: '#000000', opacity: 0.38 },
        { offset: '100%', color: '#000000', opacity: 0 },
      ],
    },
  ];

  const grey = options.silhouette;
  const outline = grey ? '#0f172a' : shade(spec.accent, -0.45);

  const shapes: Shape[] = [
    // Ground shadow, outside the scale transform so every creature sits on the
    // same floor regardless of how large it looms.
    {
      kind: 'ellipse',
      cx: 50,
      cy: 93,
      rx: 26,
      ry: 5,
      fill: `${GRADIENT_REF}${shadowGradient}`,
    },
    {
      kind: 'group',
      transform: `translate(50 58) scale(${spec.scale}) translate(-50 -58)`,
      children: [
        ...(grey ? [] : aura(spec)),
        ...wings(spec),
        ...tail(spec),
        ...limbs(spec, body),
        ...crown(spec),
        ...ears(spec, body),

        // Underside first, then the lit body on top of it: a cheap way to get a
        // rim of shadow without needing a clip path in the drawing model.
        body.draw({ fill: outline, opacity: 0.55 }, 3),
        body.draw({ fill: `${GRADIENT_REF}${bodyGradient}` }),
        body.draw({ fill: 'none', stroke: outline, strokeWidth: 1.6, opacity: 0.55 }),

        ...(grey ? [] : texture(spec, body)),
        ...(grey ? [] : pattern(spec, body)),

        // Specular highlight, up and to the left of the light in the gradient.
        {
          kind: 'ellipse',
          cx: 50 - body.rx * 0.36,
          cy: body.cy - body.ry * 0.52,
          rx: body.rx * 0.26,
          ry: body.ry * 0.16,
          fill: '#ffffff',
          opacity: grey ? 0 : 0.22,
          rotate: -18,
        },

        ...eyes(spec, body),

        // Mouth and cheeks are sized off the head, not the body, so a serpent
        // does not end up with cheeks wider than its own head.
        {
          kind: 'path',
          d: `M${50 - body.faceR * 0.28} ${body.faceY + body.faceR * 0.72} q ${body.faceR * 0.28} ${body.faceR * 0.28} ${body.faceR * 0.56} 0`,
          stroke: '#1c2333',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          fill: 'none',
        },
        ...[-1, 1].map((side): Shape => ({
          kind: 'ellipse',
          cx: 50 + side * body.faceR * 1.05,
          cy: body.faceY + body.faceR * 0.55,
          rx: body.faceR * 0.28,
          ry: body.faceR * 0.19,
          fill: '#ff8fa3',
          opacity: grey ? 0 : 0.45,
        })),
      ],
    },
  ];

  return {
    viewBox: VIEW_BOX,
    gradients,
    shapes: grey ? greyOut(shapes) : shapes,
  };
}

/**
 * Collapses a colour to the silhouette ramp, preserving relative lightness.
 *
 * Greying only the body gradient was not enough: crowns, tails, ears and wings
 * paint straight from the palette, so an un-caught album slot still showed a
 * creature's exact colours through its own crown. Since the album is meant to
 * tell a child *that* something is missing without telling him *what*, every
 * colour has to go through here.
 */
function toSilhouette(color: string | undefined): string | undefined {
  if (color === undefined || color === 'none') return color;
  if (color.startsWith(GRADIENT_REF)) return color;
  if (!color.startsWith('#')) return color;

  const solid = shade(color, 0);
  if (solid === color && !/^#[0-9a-f]{6}$/i.test(solid)) return color;

  const r = parseInt(solid.slice(1, 3), 16);
  const g = parseInt(solid.slice(3, 5), 16);
  const b = parseInt(solid.slice(5, 7), 16);
  if ([r, g, b].some(Number.isNaN)) return color;

  // Perceived lightness, mapped onto a narrow slate ramp.
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const lo = { r: 0x1e, g: 0x29, b: 0x3b };
  const hi = { r: 0x64, g: 0x74, b: 0x8b };
  const mix = (a: number, b2: number) =>
    Math.round(a + (b2 - a) * luminance)
      .toString(16)
      .padStart(2, '0');

  return `#${mix(lo.r, hi.r)}${mix(lo.g, hi.g)}${mix(lo.b, hi.b)}`;
}

/** Applies `toSilhouette` to every paint in a tree. */
function greyOut(shapes: readonly Shape[]): Shape[] {
  return shapes.map((shape) => {
    if (shape.kind === 'group') return { ...shape, children: greyOut(shape.children) };
    return { ...shape, fill: toSilhouette(shape.fill), stroke: toSilhouette(shape.stroke) };
  });
}

/** Flattens a drawing to a list of leaves. Used by the tests. */
export function flattenShapes(shapes: readonly Shape[]): Shape[] {
  return shapes.flatMap((shape) =>
    shape.kind === 'group' ? flattenShapes(shape.children) : [shape],
  );
}
