import type { ArtSpec, Creature } from '@/lib/game/creatures';

/**
 * Procedural creature art.
 *
 * Every monster in the game is drawn here from its `ArtSpec` rather than
 * loaded as an image. That means: no third-party sprites, no runtime image
 * requests, perfect scaling at any size, and recolouring for free. Eighteen
 * creatures cost about six kilobytes of geometry.
 *
 * Pure and hook-free so it renders on the server as happily as on the client.
 */

type Props = {
  creature: Creature;
  /** Rendered size in pixels. */
  size?: number;
  /** Mirrors the creature to face left - used for the opponent. */
  facing?: 'left' | 'right';
  /** Idle bob. Disabled automatically under prefers-reduced-motion. */
  animate?: boolean;
  className?: string;
  /** Greys the creature out for un-caught album slots. */
  silhouette?: boolean;
};

function Eyes({ spec }: { spec: ArtSpec }) {
  const y = 50;
  const left = 39;
  const right = 61;

  if (spec.eyes === 'sleepy') {
    return (
      <g stroke="#1c2333" strokeWidth={3} strokeLinecap="round" fill="none">
        <path d={`M${left - 6} ${y} q 6 6 12 0`} />
        <path d={`M${right - 6} ${y} q 6 6 12 0`} />
      </g>
    );
  }

  const pupil = spec.eyes === 'star' ? '#ffd23f' : '#1c2333';
  const radius = spec.eyes === 'fierce' ? 6.5 : 7.5;

  return (
    <g>
      {[left, right].map((cx) => (
        <g key={cx}>
          <ellipse cx={cx} cy={y} rx={radius} ry={radius + 1} fill="#ffffff" />
          {spec.eyes === 'star' ? (
            <path
              d={`M${cx} ${y - 5} l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z`}
              fill={pupil}
            />
          ) : (
            <>
              <circle cx={cx} cy={y + 1} r={3.6} fill={pupil} />
              <circle cx={cx + 1.4} cy={y - 1.4} r={1.5} fill="#ffffff" />
            </>
          )}
        </g>
      ))}
      {spec.eyes === 'fierce' && (
        <g stroke="#1c2333" strokeWidth={3} strokeLinecap="round">
          <path d={`M${left - 8} ${y - 9} l 13 4`} />
          <path d={`M${right + 8} ${y - 9} l -13 4`} />
        </g>
      )}
    </g>
  );
}

function Crown({ spec }: { spec: ArtSpec }) {
  const { crown, accent } = spec;
  if (crown === 'none') return null;

  switch (crown) {
    case 'flame':
      return (
        <g>
          <path
            d="M50 4 C56 14 64 18 62 26 C60 33 52 34 50 34 C48 34 40 33 38 26 C36 18 44 14 50 4 Z"
            fill={accent}
          />
          <path d="M50 14 C53 20 56 22 55 26 C54 30 51 30 50 30 C49 30 46 30 45 26 C44 22 47 20 50 14 Z" fill="#fff4d6" />
        </g>
      );
    case 'leaf':
      return (
        <g fill={accent}>
          <path d="M50 30 C50 18 42 10 34 10 C34 20 40 29 50 30 Z" />
          <path d="M50 30 C50 18 58 10 66 10 C66 20 60 29 50 30 Z" />
          <rect x={48.5} y={26} width={3} height={8} rx={1.5} fill="#7a5c2e" />
        </g>
      );
    case 'crystal':
      return (
        <g fill={accent} opacity={0.95}>
          <path d="M50 2 L57 22 L43 22 Z" />
          <path d="M35 12 L41 26 L29 26 Z" />
          <path d="M65 12 L71 26 L59 26 Z" />
        </g>
      );
    case 'bolt':
      return <path d="M54 2 L38 22 L48 22 L44 36 L62 15 L51 15 Z" fill={accent} />;
    case 'rock':
      return (
        <g fill={accent}>
          <path d="M36 26 L42 12 L50 24 Z" />
          <path d="M48 24 L57 10 L66 26 Z" />
        </g>
      );
    case 'fin':
      return <path d="M50 2 C58 12 62 20 60 30 L40 30 C38 20 42 12 50 2 Z" fill={accent} opacity={0.9} />;
    case 'horn':
      return (
        <g fill={accent}>
          <path d="M34 30 C30 20 32 12 38 8 C40 16 42 24 44 30 Z" />
          <path d="M66 30 C70 20 68 12 62 8 C60 16 58 24 56 30 Z" />
        </g>
      );
    default:
      return null;
  }
}

function Tail({ spec }: { spec: ArtSpec }) {
  const { tail, accent, primary } = spec;
  if (tail === 'none') return null;

  switch (tail) {
    case 'puff':
      return <circle cx={88} cy={68} r={10} fill={primary} />;
    case 'blade':
      return <path d="M76 62 L98 48 L94 74 Z" fill={accent} />;
    case 'curl':
      // Starts clear of the right arm so the two do not merge into a blob.
      return (
        <path
          d="M80 72 C96 74 102 60 93 53 C88 49 82 52 83 58"
          stroke={primary}
          strokeWidth={7}
          strokeLinecap="round"
          fill="none"
        />
      );
    case 'spark':
      return <path d="M76 66 L92 58 L84 68 L98 62 L82 78 L86 68 Z" fill={accent} />;
    default:
      return null;
  }
}

function Pattern({ spec }: { spec: ArtSpec }) {
  const { pattern, secondary, accent } = spec;
  switch (pattern) {
    case 'belly':
      return <ellipse cx={50} cy={68} rx={19} ry={15} fill={secondary} opacity={0.85} />;
    case 'spots':
      return (
        <g fill={accent} opacity={0.55}>
          <circle cx={36} cy={68} r={5} />
          <circle cx={62} cy={72} r={4} />
          <circle cx={50} cy={62} r={3.2} />
        </g>
      );
    case 'stripes':
      return (
        <g stroke={accent} strokeWidth={4} strokeLinecap="round" fill="none" opacity={0.6}>
          <path d="M32 64 q 18 8 36 0" />
          <path d="M34 74 q 16 7 32 0" />
        </g>
      );
    default:
      return null;
  }
}

/**
 * Half-width of each body shape, so arms and feet sit against the silhouette
 * instead of floating beside the narrower ones.
 */
const BODY_HALF_WIDTH: Record<ArtSpec['shape'], number> = {
  round: 31,
  tall: 25,
  blob: 31,
  spiky: 30,
};

function Body({ spec, gradientId }: { spec: ArtSpec; gradientId: string }) {
  const fill = `url(#${gradientId})`;

  switch (spec.shape) {
    case 'round':
      return <ellipse cx={50} cy={58} rx={31} ry={29} fill={fill} />;
    case 'tall':
      return <ellipse cx={50} cy={54} rx={25} ry={35} fill={fill} />;
    case 'blob':
      return (
        <path
          d="M50 24 C28 24 19 42 19 58 C19 78 33 88 50 88 C67 88 81 78 81 58 C81 42 72 24 50 24 Z"
          fill={fill}
        />
      );
    case 'spiky':
      return (
        <g fill={fill}>
          {Array.from({ length: 9 }, (_, i) => {
            const angle = (i / 9) * Math.PI * 2 - Math.PI / 2;
            const x = 50 + Math.cos(angle) * 30;
            const y = 58 + Math.sin(angle) * 29;
            const tipX = 50 + Math.cos(angle) * 41;
            const tipY = 58 + Math.sin(angle) * 39;
            const sx = 50 + Math.cos(angle + 0.28) * 30;
            const sy = 58 + Math.sin(angle + 0.28) * 29;
            return <path key={i} d={`M${x} ${y} L${tipX} ${tipY} L${sx} ${sy} Z`} />;
          })}
          <ellipse cx={50} cy={58} rx={30} ry={29} />
        </g>
      );
    default:
      return null;
  }
}

export function CreatureArt({
  creature,
  size = 128,
  facing = 'right',
  animate = true,
  className = '',
  silhouette = false,
}: Props) {
  const spec = creature.art;
  // Deterministic per creature. Two instances of the same creature emit
  // identical <defs>, which is harmless, and it keeps this component hook-free
  // so it can render on the server.
  const gradientId = `mm-body-${creature.id}`;
  const shadowId = `mm-shadow-${creature.id}`;

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      role="img"
      aria-label={creature.name.en}
      className={[
        animate ? 'animate-float' : '',
        silhouette ? 'opacity-40 grayscale' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ transform: facing === 'left' ? 'scaleX(-1)' : undefined, overflow: 'visible' }}
    >
      <defs>
        <radialGradient id={gradientId} cx="38%" cy="30%" r="78%">
          <stop offset="0%" stopColor={spec.secondary} />
          <stop offset="55%" stopColor={spec.primary} />
          <stop offset="100%" stopColor={spec.accent} stopOpacity={0.65} />
        </radialGradient>
        <radialGradient id={shadowId}>
          <stop offset="0%" stopColor="#000000" stopOpacity={0.35} />
          <stop offset="100%" stopColor="#000000" stopOpacity={0} />
        </radialGradient>
      </defs>

      <ellipse cx={50} cy={93} rx={26} ry={5} fill={`url(#${shadowId})`} />

      <g transform={`translate(50 58) scale(${spec.scale}) translate(-50 -58)`}>
        <Tail spec={spec} />

        {/* Feet, tucked behind the body so they read as little nubs. */}
        <ellipse cx={38} cy={85} rx={9} ry={6} fill={spec.accent} opacity={0.9} />
        <ellipse cx={62} cy={85} rx={9} ry={6} fill={spec.accent} opacity={0.9} />

        <Crown spec={spec} />
        <Body spec={spec} gradientId={gradientId} />
        <Pattern spec={spec} />

        {/* Arms, tucked against whichever silhouette this creature has. */}
        {[50 - (BODY_HALF_WIDTH[spec.shape] - 2), 50 + (BODY_HALF_WIDTH[spec.shape] - 2)].map(
          (cx, i) => (
            <ellipse
              key={cx}
              cx={cx}
              cy={62}
              rx={7}
              ry={9}
              fill={spec.primary}
              transform={`rotate(${i === 0 ? -18 : 18} ${cx} 62)`}
            />
          ),
        )}

        <Eyes spec={spec} />

        {/* Mouth. */}
        <path d="M45 63 q 5 5 10 0" stroke="#1c2333" strokeWidth={2.4} fill="none" strokeLinecap="round" />

        {/* Cheeks. */}
        <ellipse cx={30} cy={60} rx={5} ry={3.4} fill="#ff8fa3" opacity={0.5} />
        <ellipse cx={70} cy={60} rx={5} ry={3.4} fill="#ff8fa3" opacity={0.5} />
      </g>
    </svg>
  );
}

export default CreatureArt;
