import Svg, { Circle, Defs, Ellipse, G, Path, RadialGradient, Rect, Stop } from 'react-native-svg';
import { GRADIENT_REF, type Creature, type Shape, drawCreature } from '../engine';

/**
 * The iOS renderer.
 *
 * Every number it draws comes from `src/lib/game/art.ts`, shared with the web
 * client. This file only knows how to turn a primitive into a react-native-svg
 * element, which is why the two clients cannot drift: there is one copy of the
 * geometry and two dumb renderers.
 *
 * The previous version was a hand-port of the whole web component, and the risk
 * it carried was silent - a creature losing its crown on one platform renders as
 * nothing, and nothing looks like art rather than a bug.
 */

type Props = {
  creature: Creature;
  size?: number;
  /** Mirrors the creature to face left - used for the opponent. */
  facing?: 'left' | 'right';
  /** Greys out un-caught album slots. */
  silhouette?: boolean;
};

/** `grad:<id>` means "the gradient with this id"; anything else is a colour. */
function paintValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.startsWith(GRADIENT_REF) ? `url(#${value.slice(GRADIENT_REF.length)})` : value;
}

function paint(shape: Extract<Shape, { kind: 'path' }>) {
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
        <G transform={shape.transform} opacity={shape.opacity}>
          {shape.children.map((child, i) => (
            <Primitive key={i} shape={child} />
          ))}
        </G>
      );

    case 'ellipse':
      return (
        <Ellipse
          cx={shape.cx}
          cy={shape.cy}
          rx={shape.rx}
          ry={shape.ry}
          transform={shape.rotate ? `rotate(${shape.rotate} ${shape.cx} ${shape.cy})` : undefined}
          {...paint(shape as never)}
        />
      );

    case 'circle':
      return <Circle cx={shape.cx} cy={shape.cy} r={shape.r} {...paint(shape as never)} />;

    case 'rect':
      return (
        <Rect
          x={shape.x}
          y={shape.y}
          width={shape.width}
          height={shape.height}
          rx={shape.rx}
          {...paint(shape as never)}
        />
      );

    case 'path':
      return <Path d={shape.d} {...paint(shape)} />;

    default:
      return null;
  }
}

export function CreatureArt({ creature, size = 128, facing = 'right', silhouette = false }: Props) {
  const drawing = drawCreature(creature, { silhouette });

  return (
    <Svg
      viewBox={drawing.viewBox}
      width={size}
      height={size}
      // react-native-svg has no CSS, so the mirror is a transform on the root.
      style={facing === 'left' ? { transform: 'scaleX(-1)' } : undefined}
      accessibilityRole="image"
      accessibilityLabel={creature.name.en}
    >
      <Defs>
        {drawing.gradients.map((gradient) => (
          <RadialGradient
            key={gradient.id}
            id={gradient.id}
            cx={gradient.cx}
            cy={gradient.cy}
            r={gradient.r}
          >
            {gradient.stops.map((stop, i) => (
              <Stop
                key={i}
                offset={stop.offset}
                stopColor={stop.color}
                stopOpacity={stop.opacity}
              />
            ))}
          </RadialGradient>
        ))}
      </Defs>

      {drawing.shapes.map((shape, i) => (
        <Primitive key={i} shape={shape} />
      ))}
    </Svg>
  );
}

export default CreatureArt;
