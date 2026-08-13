import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import type { ArtSpec, Creature } from '../engine';

/**
 * Procedural creature art, ported to react-native-svg.
 *
 * The geometry here is identical to the web client's `CreatureArt.tsx` - same
 * viewBox, same path data, same spec fields - because both draw from the same
 * `ArtSpec` in the shared roster. Adding a creature to `creatures.ts` gives it
 * art on both clients with no image and no export step.
 *
 * Kept hook-free and pure so it is cheap to render eighteen of these at once in
 * the album.
 */

type Props = {
  creature: Creature;
  size?: number;
  /** Mirrors the creature to face left - used for the opponent. */
  facing?: 'left' | 'right';
  /** Greys out un-caught album slots. */
  silhouette?: boolean;
};

function Eyes({ spec }: { spec: ArtSpec }) {
  const y = 50;
  const left = 39;
  const right = 61;

  if (spec.eyes === 'sleepy') {
    return (
      <G stroke="#1c2333" strokeWidth={3} strokeLinecap="round" fill="none">
        <Path d={`M${left - 6} ${y} q 6 6 12 0`} />
        <Path d={`M${right - 6} ${y} q 6 6 12 0`} />
      </G>
    );
  }

  const pupil = spec.eyes === 'star' ? '#ffd23f' : '#1c2333';
  const radius = spec.eyes === 'fierce' ? 6.5 : 7.5;

  return (
    <G>
      {[left, right].map((cx) => (
        <G key={cx}>
          <Ellipse cx={cx} cy={y} rx={radius} ry={radius + 1} fill="#ffffff" />
          {spec.eyes === 'star' ? (
            <Path
              d={`M${cx} ${y - 5} l1.6 3.3 3.6.5-2.6 2.5.6 3.6-3.2-1.7-3.2 1.7.6-3.6-2.6-2.5 3.6-.5z`}
              fill={pupil}
            />
          ) : (
            <G>
              <Circle cx={cx} cy={y + 1} r={3.6} fill={pupil} />
              <Circle cx={cx + 1.4} cy={y - 1.4} r={1.5} fill="#ffffff" />
            </G>
          )}
        </G>
      ))}
      {spec.eyes === 'fierce' && (
        <G stroke="#1c2333" strokeWidth={3} strokeLinecap="round">
          <Path d={`M${left - 8} ${y - 9} l 13 4`} />
          <Path d={`M${right + 8} ${y - 9} l -13 4`} />
        </G>
      )}
    </G>
  );
}

function Crown({ spec }: { spec: ArtSpec }) {
  const { crown, accent } = spec;

  switch (crown) {
    case 'flame':
      return (
        <G>
          <Path
            d="M50 4 C56 14 64 18 62 26 C60 33 52 34 50 34 C48 34 40 33 38 26 C36 18 44 14 50 4 Z"
            fill={accent}
          />
          <Path
            d="M50 14 C53 20 56 22 55 26 C54 30 51 30 50 30 C49 30 46 30 45 26 C44 22 47 20 50 14 Z"
            fill="#fff4d6"
          />
        </G>
      );
    case 'leaf':
      return (
        <G fill={accent}>
          <Path d="M50 30 C50 18 42 10 34 10 C34 20 40 29 50 30 Z" />
          <Path d="M50 30 C50 18 58 10 66 10 C66 20 60 29 50 30 Z" />
          <Rect x={48.5} y={26} width={3} height={8} rx={1.5} fill="#7a5c2e" />
        </G>
      );
    case 'crystal':
      return (
        <G fill={accent} opacity={0.95}>
          <Path d="M50 2 L57 22 L43 22 Z" />
          <Path d="M35 12 L41 26 L29 26 Z" />
          <Path d="M65 12 L71 26 L59 26 Z" />
        </G>
      );
    case 'bolt':
      return <Path d="M54 2 L38 22 L48 22 L44 36 L62 15 L51 15 Z" fill={accent} />;
    case 'rock':
      return (
        <G fill={accent}>
          <Path d="M36 26 L42 12 L50 24 Z" />
          <Path d="M48 24 L57 10 L66 26 Z" />
        </G>
      );
    case 'fin':
      return (
        <Path d="M50 2 C58 12 62 20 60 30 L40 30 C38 20 42 12 50 2 Z" fill={accent} opacity={0.9} />
      );
    case 'horn':
      return (
        <G fill={accent}>
          <Path d="M34 30 C30 20 32 12 38 8 C40 16 42 24 44 30 Z" />
          <Path d="M66 30 C70 20 68 12 62 8 C60 16 58 24 56 30 Z" />
        </G>
      );
    default:
      return null;
  }
}

function Tail({ spec }: { spec: ArtSpec }) {
  const { tail, accent, primary } = spec;

  switch (tail) {
    case 'puff':
      return <Circle cx={88} cy={68} r={10} fill={primary} />;
    case 'blade':
      return <Path d="M76 62 L98 48 L94 74 Z" fill={accent} />;
    case 'curl':
      // Starts clear of the right arm so the two do not merge into a blob.
      return (
        <Path
          d="M80 72 C96 74 102 60 93 53 C88 49 82 52 83 58"
          stroke={primary}
          strokeWidth={7}
          strokeLinecap="round"
          fill="none"
        />
      );
    case 'spark':
      return <Path d="M76 66 L92 58 L84 68 L98 62 L82 78 L86 68 Z" fill={accent} />;
    default:
      return null;
  }
}

function Pattern({ spec }: { spec: ArtSpec }) {
  const { pattern, secondary, accent } = spec;
  switch (pattern) {
    case 'belly':
      return <Ellipse cx={50} cy={68} rx={19} ry={15} fill={secondary} opacity={0.85} />;
    case 'spots':
      return (
        <G fill={accent} opacity={0.55}>
          <Circle cx={36} cy={68} r={5} />
          <Circle cx={62} cy={72} r={4} />
          <Circle cx={50} cy={62} r={3.2} />
        </G>
      );
    case 'stripes':
      return (
        <G stroke={accent} strokeWidth={4} strokeLinecap="round" fill="none" opacity={0.6}>
          <Path d="M32 64 q 18 8 36 0" />
          <Path d="M34 74 q 16 7 32 0" />
        </G>
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
      return <Ellipse cx={50} cy={58} rx={31} ry={29} fill={fill} />;
    case 'tall':
      return <Ellipse cx={50} cy={54} rx={25} ry={35} fill={fill} />;
    case 'blob':
      return (
        <Path
          d="M50 24 C28 24 19 42 19 58 C19 78 33 88 50 88 C67 88 81 78 81 58 C81 42 72 24 50 24 Z"
          fill={fill}
        />
      );
    case 'spiky':
      return (
        <G fill={fill}>
          {Array.from({ length: 9 }, (_, i) => {
            const angle = (i / 9) * Math.PI * 2 - Math.PI / 2;
            const x = 50 + Math.cos(angle) * 30;
            const y = 58 + Math.sin(angle) * 29;
            const tipX = 50 + Math.cos(angle) * 41;
            const tipY = 58 + Math.sin(angle) * 39;
            const sx = 50 + Math.cos(angle + 0.28) * 30;
            const sy = 58 + Math.sin(angle + 0.28) * 29;
            return <Path key={i} d={`M${x} ${y} L${tipX} ${tipY} L${sx} ${sy} Z`} />;
          })}
          <Ellipse cx={50} cy={58} rx={30} ry={29} />
        </G>
      );
    default:
      return null;
  }
}

export function CreatureArt({ creature, size = 128, facing = 'right', silhouette = false }: Props) {
  const spec = creature.art;
  const gradientId = `mm-body-${creature.id}`;
  const shadowId = `mm-shadow-${creature.id}`;

  return (
    <Svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      // react-native-svg has no CSS, so the mirror is a transform on the root.
      style={[{ opacity: silhouette ? 0.35 : 1 }, facing === 'left' && { transform: 'scaleX(-1)' }]}
      accessibilityRole="image"
      accessibilityLabel={creature.name.en}
    >
      <Defs>
        <RadialGradient id={gradientId} cx="38%" cy="30%" r="78%">
          <Stop offset="0%" stopColor={silhouette ? '#334155' : spec.secondary} />
          <Stop offset="55%" stopColor={silhouette ? '#1e293b' : spec.primary} />
          <Stop offset="100%" stopColor={silhouette ? '#0f172a' : spec.accent} stopOpacity={0.65} />
        </RadialGradient>
        <RadialGradient id={shadowId}>
          <Stop offset="0%" stopColor="#000000" stopOpacity={0.35} />
          <Stop offset="100%" stopColor="#000000" stopOpacity={0} />
        </RadialGradient>
      </Defs>

      <Ellipse cx={50} cy={93} rx={26} ry={5} fill={`url(#${shadowId})`} />

      <G transform={`translate(50 58) scale(${spec.scale}) translate(-50 -58)`}>
        <Tail spec={spec} />

        {/* Feet, tucked behind the body so they read as little nubs. */}
        <Ellipse cx={38} cy={85} rx={9} ry={6} fill={spec.accent} opacity={0.9} />
        <Ellipse cx={62} cy={85} rx={9} ry={6} fill={spec.accent} opacity={0.9} />

        <Crown spec={spec} />
        <Body spec={spec} gradientId={gradientId} />
        <Pattern spec={spec} />

        {/* Arms, tucked against whichever silhouette this creature has. */}
        {[50 - (BODY_HALF_WIDTH[spec.shape] - 2), 50 + (BODY_HALF_WIDTH[spec.shape] - 2)].map(
          (cx, i) => (
            <Ellipse
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

        <Path
          d="M45 63 q 5 5 10 0"
          stroke="#1c2333"
          strokeWidth={2.4}
          fill="none"
          strokeLinecap="round"
        />

        <Ellipse cx={30} cy={60} rx={5} ry={3.4} fill="#ff8fa3" opacity={0.5} />
        <Ellipse cx={70} cy={60} rx={5} ry={3.4} fill="#ff8fa3" opacity={0.5} />
      </G>
    </Svg>
  );
}

export default CreatureArt;
