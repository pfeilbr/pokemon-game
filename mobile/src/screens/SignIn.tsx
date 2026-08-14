import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { AuthFailure } from '../api';
import type { StringKey } from '../engine';
import { useGame } from '../game/GameContext';
import { TAP, colors, radius, space } from '../theme';
import { Button, Panel } from '../ui/kit';

/**
 * Signing in, with a trainer name and a four-digit PIN.
 *
 * An upgrade, never a gate: the game is fully playable without ever opening
 * this screen, and the device save is what it plays from either way. All an
 * account buys is that the album follows him to another device.
 *
 * No email, no password, no third party. A seven-year-old can type four digits
 * he chose himself; the security that makes that safe is the server's lockout,
 * not the length of the secret.
 */

/** The server's own limits, so a child hears about a typo before a round trip. */
export const NAME_MIN = 2;
export const NAME_MAX = 16;
export const PIN_LENGTH = 4;

export type LocalProblem = 'name' | 'pin' | null;

/**
 * What is wrong with what has been typed, before anything is sent.
 *
 * Mirrors `isValidName` / `isValidPin` in `src/lib/server/accounts.ts`. Pure and
 * exported so the rules can be tested without a renderer - and so the fact that
 * they mirror the server's is visible in one place rather than buried in JSX.
 */
export function localProblem(name: string, pin: string): LocalProblem {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN || trimmed.length > NAME_MAX) return 'name';
  if (!/^\d{4}$/.test(pin)) return 'pin';
  return null;
}

/**
 * The message for a failure the server reported.
 *
 * `mismatch` deliberately reads the same whether the name is unknown or the PIN
 * is wrong, because the server refuses to distinguish them - saying "no such
 * trainer" here would hand back exactly the enumeration the endpoint is built
 * to prevent.
 */
export function messageFor(reason: AuthFailure): StringKey {
  switch (reason) {
    case 'mismatch':
      return 'wrongPin';
    case 'taken':
      return 'nameTaken';
    case 'invalid':
      return 'pinFourDigits';
    case 'locked':
    case 'unavailable':
    case 'network':
      return 'somethingWentWrong';
  }
}

export function SignIn({ onDone }: { onDone: () => void }) {
  const { tr, session, signIn, feedback } = useGame();

  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<StringKey | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const problem = localProblem(name, pin);
    if (problem) {
      setError(problem === 'name' ? 'nameTooShort' : 'pinFourDigits');
      feedback('wrong');
      return;
    }

    setError(null);
    setBusy(true);
    const result = await signIn(name.trim(), pin, mode);
    setBusy(false);

    if (result.ok) {
      feedback('win');
      onDone();
      return;
    }
    feedback('wrong');
    setError(messageFor(result.reason));
  };

  // With no database attached the deployment has no accounts at all, and the
  // web client says so plainly rather than offering a form that cannot work.
  if (session && !session.accountsAvailable) {
    return (
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>{tr('signIn')}</Text>
        <Panel>
          <Text style={styles.blurb}>{tr('savedLocally')}</Text>
        </Panel>
        <Button label={`← ${tr('back')}`} variant="ghost" onPress={onDone} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <Text style={styles.title}>{tr('signInToSave')}</Text>
      <Text style={styles.blurb}>{tr('signInBlurb')}</Text>

      <Panel>
        <Text style={styles.label}>{tr('chooseName')}</Text>
        <TextInput
          testID="signin-name"
          value={name}
          onChangeText={setName}
          placeholder={tr('namePlaceholder')}
          placeholderTextColor={colors.faint}
          style={styles.input}
          autoCorrect={false}
          autoCapitalize="none"
          maxLength={NAME_MAX}
        />

        <Text style={styles.label}>{tr('pin')}</Text>
        <TextInput
          testID="signin-pin"
          value={pin}
          // Digits only, so the field cannot hold something the server will
          // reject; `secureTextEntry` because a PIN is typed in front of people.
          onChangeText={(text) => setPin(text.replace(/\D/g, '').slice(0, PIN_LENGTH))}
          placeholder="••••"
          placeholderTextColor={colors.faint}
          style={styles.input}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={PIN_LENGTH}
        />
        <Text style={styles.hint}>{tr('pinHint')}</Text>

        {error && (
          <Text testID="signin-error" style={styles.error}>
            {tr(error)}
          </Text>
        )}

        {busy ? (
          <ActivityIndicator color={colors.gold} />
        ) : (
          <Button
            testID="signin-submit"
            label={mode === 'register' ? tr('createAccount') : tr('signIn')}
            onPress={() => void submit()}
          />
        )}
      </Panel>

      <View style={styles.actions}>
        <Button
          testID="signin-toggle-mode"
          label={mode === 'register' ? tr('haveAccount') : tr('needAccount')}
          variant="secondary"
          onPress={() => {
            feedback('tap');
            setError(null);
            setMode((current) => (current === 'register' ? 'login' : 'register'));
          }}
        />
        <Button label={tr('playWithoutAccount')} variant="ghost" onPress={onDone} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: 32, gap: space.md, paddingBottom: space.xl },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', textAlign: 'center' },
  blurb: { color: colors.muted, fontSize: 15, textAlign: 'center', lineHeight: 21 },
  label: { color: colors.muted, fontSize: 13, fontWeight: '800', textTransform: 'uppercase' },
  input: {
    minHeight: TAP,
    borderRadius: radius.md,
    backgroundColor: 'rgba(2,6,23,0.6)',
    borderWidth: 2,
    borderColor: colors.panelEdge,
    paddingHorizontal: space.lg,
    color: colors.text,
    fontSize: 20,
    fontWeight: '700',
  },
  hint: { color: colors.faint, fontSize: 13 },
  error: { color: colors.bad, fontSize: 15, fontWeight: '800' },
  actions: { gap: space.sm },
});
