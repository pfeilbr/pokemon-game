import AsyncStorage from '@react-native-async-storage/async-storage';
import { Component, type ErrorInfo, Fragment, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { type Language, languageFromSave, recoveryPlan, t } from './engine';
import { STORAGE_KEY, clearProfile } from './storage';
import { TAP, colors, radius, space } from './theme';
import { Button } from './ui/kit';

/**
 * What a child sees instead of a dead app.
 *
 * The engine throws on invalid data by design (`getCreature` throws on an
 * unknown id) and repairs it at the boundary instead - CLAUDE.md says so, and
 * it is the right call. The cost is that a render *can* throw, and on this
 * client an unhandled render error is worse than on the web. React Native
 * unmounts the whole tree: in a Debug build that is a redbox, and in the
 * **Release** build that actually ships to the phone it is a blank screen
 * followed by the app dying. No message, no way back, and the player is seven
 * and usually alone with the device.
 *
 * There is no `error.tsx` here - that is a Next.js affordance - so the same job
 * is done the way React itself provides: a class boundary above everything that
 * can throw. It wraps `GameProvider` as well as the router, because a crash
 * while reading or reconciling the save is exactly the crash worth catching,
 * and a boundary underneath the provider would miss it.
 *
 * The three jobs are the web recovery screen's, in the same order:
 *
 *   1. Say, in the player's own language, that nothing is lost.
 *   2. Offer a big obvious "try again" - most render crashes are transient.
 *   3. Always keep a way home. A crash must never strand him on one screen.
 *
 * And the one rule that outranks all three: **it never erases the save by
 * itself.** `normaliseProfile` promises that save data outlives code; a
 * recovery screen that "helpfully" cleared storage to get the app rendering
 * again would break that promise from the other end, and the child would be
 * back in the game with his album gone and nothing on screen ever having said
 * so. Losing the album is worse than the crash.
 *
 * What is offered when is not decided here. `recoveryPlan` lives in
 * `src/lib/recovery.ts` and is shared with the web client through the seam, so
 * the two clients cannot drift on the question of when it is sane to suggest
 * erasing a child's save.
 *
 * Nothing on this screen animates. That is not an oversight: it is the reduced
 * motion path taken to its end. The client's one animation - the hit shake in
 * `BattleScreen` - has to ask `AccessibilityInfo.isReduceMotionEnabled()`
 * because iOS gives no free equivalent of the CSS media query. A screen with no
 * motion at all needs no such question and cannot get the answer wrong, and a
 * spinner on a crash screen would only make a frightening moment busier.
 *
 * Dependencies are kept deliberately thin, for the same reason the web screen
 * skips its `AppShell`: everything this does not render is something that
 * cannot crash it in turn, and a fallback that throws is a blank screen with
 * extra steps. No `useGame`, no creature art, no engine rules - only the shared
 * strings, the shared plan, and a raw storage read for the language.
 */

/** The mobile analogue of `window.location.reload()` for the erase path. */
type Props = {
  children: ReactNode;
  /**
   * Send the app back to its first screen.
   *
   * The current screen lives in `App.tsx`, *above* this boundary, which is what
   * keeps "try again" and "go home" two different things on a client with no
   * URL: retry remounts the subtree on the screen that crashed, home resets the
   * screen first. Without that split both buttons would do the same thing and
   * one of them would be a lie.
   */
  onGoHome?: () => void;
};

type State = {
  crashed: boolean;
  /**
   * Retries the player has spent on this crash.
   *
   * Instance state, not the subtree's: the boundary itself survives every retry
   * (only its children remount), so the count cannot silently reset and start
   * hiding the last remaining exit from a child stuck in a repeating crash.
   */
  failedRetries: number;
  confirmingErase: boolean;
  /** Bumping this remounts everything below - this client's "reload". */
  attempt: number;
  language: Language;
};

export class CrashBoundary extends Component<Props, State> {
  state: State = {
    crashed: false,
    failedRetries: 0,
    confirmingErase: false,
    attempt: 0,
    language: 'en',
  };

  private live = false;

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true };
  }

  componentDidMount(): void {
    this.live = true;
    // Read the language now rather than only after a crash, so the fallback
    // does not appear in English for a frame and then switch under him.
    this.refreshLanguage();
  }

  componentWillUnmount(): void {
    this.live = false;
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // The child cannot read a stack trace and must not be shown one. A parent
    // with Xcode's console, or a crash report, can.
    console.error('Mathmon crashed:', error, info.componentStack);
    // He may have changed the language since mount.
    this.refreshLanguage();
  }

  /**
   * The player's language, from the raw saved bytes.
   *
   * Deliberately not `loadProfile`: this screen renders precisely when
   * something else has thrown, so it must not route its own text back through
   * the engine that may be what broke. `languageFromSave` is pure, is the same
   * function the web screen uses, and treats a save it cannot parse as English
   * rather than as a second error.
   */
  private refreshLanguage(): void {
    void AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        const language = languageFromSave(raw);
        if (this.live && language !== this.state.language) this.setState({ language });
      })
      .catch(() => {
        // A storage read that fails is not worth a second crash; English stands.
      });
  }

  /** Remount the subtree on the screen that crashed. The save is untouched. */
  private tryAgain = (): void => {
    this.setState((current) => ({
      crashed: false,
      confirmingErase: false,
      failedRetries: current.failedRetries + 1,
      attempt: current.attempt + 1,
    }));
  };

  /** Always available, and it clears the counter: this crash is over. */
  private goHome = (): void => {
    this.props.onGoHome?.();
    this.setState((current) => ({
      crashed: false,
      confirmingErase: false,
      failedRetries: 0,
      attempt: current.attempt + 1,
    }));
  };

  /**
   * The only path that touches the save, and it is four taps from the crash:
   * try again, still stuck, delete, and only after a retry has already failed.
   */
  private erase = (): void => {
    void clearProfile().then(() => {
      if (!this.live) return;
      this.props.onGoHome?.();
      // Remounting is this client's `window.location.reload()`: the point is to
      // start from nothing, and in-memory state is part of the nothing.
      this.setState((current) => ({
        crashed: false,
        confirmingErase: false,
        failedRetries: 0,
        attempt: current.attempt + 1,
      }));
    });
  };

  render(): ReactNode {
    const { crashed, confirmingErase, failedRetries, attempt, language } = this.state;

    if (!crashed) {
      // Keyed so a retry unmounts and rebuilds the subtree rather than handing
      // the same broken component instances back to React.
      return <Fragment key={attempt}>{this.props.children}</Fragment>;
    }

    const plan = recoveryPlan(failedRetries);

    return (
      <ScrollView testID="crash-recovery" style={styles.fill} contentContainerStyle={styles.screen}>
        <Text style={styles.emoji}>🩹</Text>

        <Text style={styles.title}>{t('crashTitle', language)}</Text>

        {/* The reassurance is the point of the screen, so it is not small print. */}
        <Text style={styles.body}>{t('crashBody', language)}</Text>

        <View style={styles.actions}>
          {plan.canRetry && (
            <Button
              testID="crash-try-again"
              label={t('tryAgain', language)}
              onPress={this.tryAgain}
            />
          )}
          {plan.canGoHome && (
            <Button
              testID="crash-go-home"
              variant="secondary"
              label={t('goHome', language)}
              onPress={this.goHome}
            />
          )}
        </View>

        {/* The destructive door only exists once the safe one has failed, and it
            still takes two more deliberate taps and a sentence that names the
            cost. Nothing on this screen ever clears the save on its own. */}
        {plan.offerErase &&
          (confirmingErase ? (
            <View style={styles.confirm} testID="crash-erase-confirm">
              <Text style={styles.warning}>{t('eraseSaveWarning', language)}</Text>
              <View style={styles.actions}>
                <Button
                  testID="crash-erase-cancel"
                  variant="secondary"
                  label={t('back', language)}
                  onPress={() => this.setState({ confirmingErase: false })}
                />
                <Pressable
                  testID="crash-erase-confirmed"
                  accessibilityRole="button"
                  onPress={this.erase}
                  style={({ pressed }) => [styles.danger, pressed && styles.pressed]}
                >
                  <Text style={styles.dangerText}>{t('deleteProgress', language)}</Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <Button
              testID="crash-still-stuck"
              variant="ghost"
              label={t('stillStuck', language)}
              onPress={() => this.setState({ confirmingErase: true })}
            />
          ))}
      </ScrollView>
    );
  }
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.bg },
  screen: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    gap: space.lg,
  },
  emoji: { fontSize: 64 },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', textAlign: 'center' },
  body: { color: '#cbd5e1', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  actions: { alignSelf: 'stretch', gap: space.md },
  confirm: {
    alignSelf: 'stretch',
    backgroundColor: colors.panel,
    borderColor: colors.panelEdge,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.lg,
    gap: space.md,
  },
  warning: { color: colors.bad, fontSize: 14, fontWeight: '700', textAlign: 'center' },
  danger: {
    minHeight: TAP,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    backgroundColor: colors.bad,
  },
  dangerText: { color: '#450a12', fontSize: 17, fontWeight: '800' },
  pressed: { opacity: 0.75 },
});
