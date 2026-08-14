import { Pressable, StyleSheet, Text, View } from 'react-native';
import { TAP, colors, radius, space } from '../theme';

/**
 * The answer keypad.
 *
 * An on-screen keypad rather than a `TextInput`, for the same reason the web
 * client uses one: the iOS keyboard would cover half the battle, and digits are
 * all the game ever needs - the maths generator only ever produces non-negative
 * whole numbers.
 */

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  clearLabel: string;
  onKeyPress?: () => void;
};

const MAX_DIGITS = 4;

export function Keypad({ value, onChange, onSubmit, submitLabel, clearLabel, onKeyPress }: Props) {
  const pressDigit = (digit: string) => {
    if (value.length >= MAX_DIGITS) return;
    // Stop leading zeros piling up ("007"), which look like a bug to a child.
    onChange(value === '0' ? digit : value + digit);
    onKeyPress?.();
  };

  const key = (label: string, onPress: () => void, small = false) => (
    <Pressable
      key={label}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={`key-${label}`}
      onPress={onPress}
      style={({ pressed }) => [styles.key, pressed && styles.keyPressed]}
    >
      <Text style={[styles.keyText, small && styles.keyTextSmall]}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={styles.wrap}>
      <View style={styles.display}>
        <Text
          testID="answer-display"
          style={[styles.displayText, !value && styles.displayEmpty]}
          accessibilityLiveRegion="polite"
        >
          {value || '?'}
        </Text>
      </View>

      <View style={styles.grid}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, () => pressDigit(d)))}
        {key(
          clearLabel,
          () => {
            onChange('');
            onKeyPress?.();
          },
          true,
        )}
        {key('0', () => pressDigit('0'))}
        {key('⌫', () => {
          onChange(value.slice(0, -1));
          onKeyPress?.();
        })}
      </View>

      <Pressable
        testID="submit-answer"
        accessibilityRole="button"
        disabled={value.length === 0}
        onPress={onSubmit}
        style={({ pressed }) => [
          styles.submit,
          pressed && styles.submitPressed,
          value.length === 0 && styles.submitDisabled,
        ]}
      >
        <Text style={styles.submitText}>{submitLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  display: {
    height: 64,
    borderRadius: radius.md,
    backgroundColor: 'rgba(2,6,23,0.7)',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  displayText: {
    fontSize: 40,
    fontWeight: '900',
    color: colors.gold,
    fontVariant: ['tabular-nums'],
  },
  // The "?" standing in for an answer not yet typed. It was `#334155`, which
  // is 1.91:1 on the display's own near-black - the same failure, to within
  // three hundredths, that `scripts/audit_contrast.py` found in the web
  // client's PIN placeholder at 1.86:1. A placeholder is text a child reads to
  // know what the box is for, so it takes the quiet-label colour rather than a
  // shade of the background.
  displayEmpty: { color: colors.faint },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  key: {
    // Three per row, accounting for the two gaps between them.
    width: `${(100 - 2 * 3) / 3}%`,
    height: TAP,
    borderRadius: radius.md,
    backgroundColor: 'rgba(30,41,59,0.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyPressed: { backgroundColor: '#334155', transform: [{ scale: 0.95 }] },
  keyText: { fontSize: 28, fontWeight: '800', color: colors.text },
  keyTextSmall: { fontSize: 16 },
  submit: {
    minHeight: TAP,
    borderRadius: radius.md,
    backgroundColor: '#10b981',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: space.xs,
  },
  submitPressed: { backgroundColor: '#059669' },
  submitDisabled: { opacity: 0.4 },
  // Dark ink on the green, not white. White on this emerald is 2.54:1 - below
  // even the 3:1 that large text owes - which is the same pair the web client
  // was shipping at 1.94:1 before `scripts/audit_contrast.py` measured it, and
  // it was on the single most important control in the game. The web fix went
  // dark on the green too (`text-slate-900`); this is the emerald-hued
  // equivalent of the dark ink the gold buttons already use.
  submitText: { fontSize: 26, fontWeight: '900', color: '#04241b' },
});
