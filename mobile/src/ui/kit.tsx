import type { ReactNode } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { ELEMENT_STYLE, type Element, type Language, t } from '../engine';
import { TAP, colors, radius, space, tint } from '../theme';

/**
 * The shared widgets.
 *
 * Same vocabulary as the web client's `ui.tsx` - Panel, Button, HealthBar,
 * ChargeMeter, ElementChip - so the two clients stay recognisably one game.
 * Every pressable here is at least TAP tall.
 */

export function Panel({
  children,
  style,
  glow,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Element colour to tint the panel with, matching the web gradients. */
  glow?: string;
}) {
  return (
    <View style={[styles.panel, glow ? { backgroundColor: tint(glow, 0.12) } : null, style]}>
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled,
  testID,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' && styles.buttonPrimary,
        variant === 'secondary' && styles.buttonSecondary,
        variant === 'ghost' && styles.buttonGhost,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
    >
      <Text style={[styles.buttonText, variant === 'primary' && styles.buttonTextPrimary]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function ElementChip({ element, label }: { element: Element; label: string }) {
  const style = ELEMENT_STYLE[element];
  return (
    <View style={[styles.chip, { backgroundColor: tint(style.color, 0.22) }]}>
      <Text style={[styles.chipText, { color: style.color }]}>
        {style.icon} {label}
      </Text>
    </View>
  );
}

export function HealthBar({ current, max }: { current: number; max: number }) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  // Green above half, amber down to a fifth, red below - readable at a glance
  // without reading the numbers.
  const colour = ratio > 0.5 ? colors.good : ratio > 0.2 ? colors.gold : colors.bad;

  return (
    <View>
      <View style={styles.barTrack}>
        <View style={[styles.barFill, { width: `${ratio * 100}%`, backgroundColor: colour }]} />
      </View>
      <Text style={styles.barNumbers}>
        {Math.ceil(current)}/{max}
      </Text>
    </View>
  );
}

export function XpBar({
  into,
  span,
  level,
  language,
}: {
  into: number;
  span: number;
  level: number;
  language: Language;
}) {
  const ratio = span > 0 ? Math.max(0, Math.min(1, into / span)) : 1;
  return (
    <View>
      <View style={styles.barLabels}>
        <Text style={styles.barLabel}>
          {t('levelShort', language)} {level}
        </Text>
        <Text style={styles.barNumbers}>
          {span > 0 ? `${into}/${span}` : t('maxLevelReached', language)}
        </Text>
      </View>
      <View style={[styles.barTrack, { height: 10 }]}>
        <View style={[styles.barFill, { width: `${ratio * 100}%`, backgroundColor: colors.sky }]} />
      </View>
    </View>
  );
}

export function ChargeMeter({
  charge,
  max,
  label,
}: {
  charge: number;
  max: number;
  label: string;
}) {
  return (
    <View style={styles.chargeRow}>
      <Text style={styles.chargeLabel}>{label}</Text>
      {Array.from({ length: max }, (_, i) => (
        <View key={i} style={[styles.pip, i < charge ? styles.pipOn : styles.pipOff]} />
      ))}
    </View>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.panel,
    borderColor: colors.panelEdge,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  button: {
    minHeight: TAP,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  buttonPrimary: { backgroundColor: colors.gold },
  buttonSecondary: { backgroundColor: 'rgba(255,255,255,0.08)' },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  buttonTextPrimary: { color: '#3b2500' },
  pressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.35 },
  chip: {
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    alignSelf: 'flex-start',
  },
  chipText: { fontSize: 13, fontWeight: '800' },
  barTrack: {
    height: 14,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(2,6,23,0.8)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: radius.pill },
  barLabels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  barLabel: { color: '#cbd5e1', fontSize: 12, fontWeight: '800' },
  barNumbers: { color: colors.muted, fontSize: 12, marginTop: 2, textAlign: 'right' },
  chargeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  chargeLabel: { color: '#cbd5e1', fontSize: 12, fontWeight: '800', textTransform: 'uppercase' },
  pip: { width: 16, height: 16, borderRadius: 8, borderWidth: 1 },
  pipOn: { backgroundColor: colors.gold, borderColor: '#fde68a' },
  pipOff: { backgroundColor: '#1e293b', borderColor: 'rgba(255,255,255,0.15)' },
  stat: { flex: 1, alignItems: 'center' },
  statValue: { color: colors.text, fontSize: 22, fontWeight: '900' },
  statLabel: { color: colors.muted, fontSize: 11, textTransform: 'uppercase', marginTop: 2 },
});
