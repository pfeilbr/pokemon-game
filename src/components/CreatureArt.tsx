import { Fragment } from 'react';
import { GRADIENT_REF, type Gradient, type Shape, drawCreature } from '@/lib/game/art';
import type { Creature } from '@/lib/game/creatures';

/**
 * The web renderer.
 *
 * All the geometry lives in `lib/game/art.ts`; this file only knows how to turn
 * a primitive into an SVG element. That split is why the iOS client can draw
 * exactly the same creature from exactly the same numbers - its renderer is the
 * same forty lines against react-native-svg.
 *
 * Pure and hook-free, so it renders on the server as happily as on the client.
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

/** `grad:<id>` means "the gradient with this id"; anything else is a colour. */
function paintValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(GRADIENT_REF) ? `url(#${value.slice(GRADIENT_REF.length)})` : value;
}

function common(shape: Extract<Shape, { kind: 'path' }>) {
  return {
    fill: paintValue(shape.fill),
    fillOpacity: shape.fillOpacity,
    stroke: paintValue(shape.stroke),
    strokeWidth: shape.strokeWidth,
    strokeLinecap: shape.strokeLinecap,
    opacity: shape.opacity,
  };
}

function Primitive({ shape }: { shape: Shape }) {
  switch (shape.kind) {
    case 'group':
      return (
        <g transform={shape.transform} opacity={shape.opacity}>
          {shape.children.map((child, i) => (
            <Primitive key={i} shape={child} />
          ))}
        </g>
      );

    case 'ellipse':
      return (
        <ellipse
          cx={shape.cx}
          cy={shape.cy}
          rx={shape.rx}
          ry={shape.ry}
          transform={shape.rotate ? `rotate(${shape.rotate} ${shape.cx} ${shape.cy})` : undefined}
          {...common(shape as never)}
        />
      );

    case 'circle':
      return <circle cx={shape.cx} cy={shape.cy} r={shape.r} {...common(shape as never)} />;

    case 'rect':
      return (
        <rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.rx}
          {...common(shape as never)}
        />
      );

    case 'path':
      return <path d={shape.d} {...common(shape)} />;

    default:
      return null;
  }
}

function Defs({ gradients }: { gradients: Gradient[] }) {
  return (
    <defs>
      {gradients.map((gradient) => (
        <radialGradient
          key={gradient.id}
          id={gradient.id}
          cx={gradient.cx}
          cy={gradient.cy}
          r={gradient.r}
        >
          {gradient.stops.map((stop, i) => (
            <Fragment key={i}>
              <stop offset={stop.offset} stopColor={stop.color} stopOpacity={stop.opacity} />
            </Fragment>
          ))}
        </radialGradient>
      ))}
    </defs>
  );
}

export function CreatureArt({
  creature,
  size = 128,
  facing = 'right',
  animate = true,
  className = '',
  silhouette = false,
}: Props) {
  const drawing = drawCreature(creature, { silhouette });

  return (
    <svg
      viewBox={drawing.viewBox}
      width={size}
      height={size}
      role="img"
      aria-label={creature.name.en}
      className={[animate ? 'animate-float' : '', className].filter(Boolean).join(' ')}
      style={{ transform: facing === 'left' ? 'scaleX(-1)' : undefined, overflow: 'visible' }}
    >
      <Defs gradients={drawing.gradients} />
      {drawing.shapes.map((shape, i) => (
        <Primitive key={i} shape={shape} />
      ))}
    </svg>
  );
}

export default CreatureArt;
