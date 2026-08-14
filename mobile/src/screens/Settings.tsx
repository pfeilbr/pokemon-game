import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Language, Profile } from '../engine';
import { type SyncState, useGame } from '../game/GameContext';
import { TAP, colors, radius, space } from '../theme';
import { Button, Panel } from '../ui/kit';

/**
 * Settings: language, sound, the account, and starting over.
 *
 * The player is bilingual, and until this screen existed the language followed
 * whatever the profile was created with - a child who signed up in English had
 * no way back to Chinese short of deleting the save.
 *
 * The transitions below are exported as pure functions taking the current time
 * (or the current stage) as an argument, exactly like the engine's rules do, so
 * `Settings.test.ts` and `Settings.reset.test.ts` can assert what they change
 * without a React renderer.
 */

/**
 * `updatedAt` is what cross-device sync resolves conflicts on (last write wins),
 * so a device whose clock is behind must not be able to stamp a change with a
 * time older than the save it is changing - the stale copy would win and the
 * setting would flip back on the next sync. Never move it backwards.
 */
function stamp(profile: Profile, now: string): string {
  return now > profile.updatedAt ? now : profile.updatedAt;
}

/**
 * Where this child's progress is being kept, right now.
 *
 * One line, derived, rather than a fixed "saving on this device": once an
 * account exists that sentence is simply untrue, and a parent checking whether
 * sync is working is exactly who reads it.
 */
export function saveStatus(
  signedIn: boolean,
  syncState: SyncState,
): 'savedLocally' | 'syncing' | 'savedToAccount' | 'somethingWentWrong' {
  if (!signedIn) return 'savedLocally';
  if (syncState === 'saving') return 'syncing';
  if (syncState === 'error') return 'somethingWentWrong';
  return 'savedToAccount';
}

export function withLanguage(profile: Profile, language: Language, now: string): Profile {
  return {
    ...profile,
    settings: { ...profile.settings, language },
    updatedAt: stamp(profile, now),
  };
}

export function toggleSound(profile: Profile, now: string): Profile {
  return {
    ...profile,
    settings: { ...profile.settings, sound: !profile.settings.sound },
    updatedAt: stamp(profile, now),
  };
}

/** Whether the destructive control is resting or is asking. */
export type ResetStage = 'idle' | 'confirming';

/** The three presses the start-over control can receive. */
export type ResetPress = 'startOver' | 'back' | 'delete';

export type ResetStep = {
  stage: ResetStage;
  /** The only field that can cost a child his album. True on one path only. */
  wipe: boolean;
};

/**
 * The gate in front of deleting the save.
 *
 * The web client has had this since the beginning; this client had nothing, so
 * a fresh start meant an adult deleting the app. What kept it out was the shape
 * of a phone: on the web the reset is a small underlined link on a page a child
 * rarely opens, whereas on a phone every control sits under his thumb.
 *
 * Hence two deliberate actions, and only the second one is destructive. It is a
 * function rather than a `useState` flag so the property can be *proved*: a
 * `delete` press that never passed through `confirming` returns `wipe: false`,
 * which is what makes a mis-tap, a stale press or a future refactor that
 * forgets the gate inert rather than final. `Settings.reset.test.ts` walks the
 * sequences against a real save.
 */
export function nextReset(stage: ResetStage, press: ResetPress): ResetStep {
  switch (press) {
    case 'startOver':
      return { stage: 'confirming', wipe: false };
    case 'back':
      return { stage: 'idle', wipe: false };
    case 'delete':
      // Never from `idle`. Asking has to have happened.
      return stage === 'confirming' ? { stage: 'idle', wipe: true } : { stage, wipe: false };
  }
}

export type StartOverPlan = {
  /** Drop the session first, which flushes anything still queued to the server. */
  signOutFirst: boolean;
  /** Always. This is the part the child asked for. */
  clearDevice: boolean;
  /** Never. See below. */
  deleteAccountCopy: false;
};

/**
 * What "start over" means for a player with an account.
 *
 * It means *start over on this device*, and deliberately nothing more. The web
 * client's reset clears local storage and leaves the server copy alone - there
 * is no endpoint on either client that deletes an account's save - so an album
 * that reached the server survives, and signing back in brings it back. A phone
 * that could erase what was earned on the laptop would be a far worse mis-tap
 * than the one the confirmation guards against.
 *
 * The one thing this client must do that the web client does not is sign out
 * *before* wiping. `signOut()` flushes the save still queued for the server, so
 * the last battle reaches the account before the device forgets it; and once
 * the session is gone, the fresh profile that sign-up creates a minute later is
 * never pushed over the old one. Wiping while still signed in would leave the
 * account holding a stale save and then quietly overwrite it - destroying the
 * server copy by accident, which is exactly what must not happen.
 */
export function startOverPlan(signedIn: boolean): StartOverPlan {
  return { signOutFirst: signedIn, clearDevice: true, deleteAccountCopy: false };
}

export function Settings({
  profile,
  onBack,
  onSignIn,
}: {
  profile: Profile;
  onBack: () => void;
  onSignIn: () => void;
}) {
  const { language, tr, update, setProfile, feedback, session, syncState, signOut } = useGame();
  const [resetStage, setResetStage] = useState<ResetStage>('idle');

  // The time is read here, in the component, and passed into the transition -
  // the same split the engine uses.
  const now = () => new Date().toISOString();

  const chooseLanguage = (next: Language) => {
    feedback('tap');
    update((p) => withLanguage(p, next, now()));
  };

  const flipSound = () => {
    // Fires only while feedback is still on, so turning it off buzzes goodbye
    // and turning it back on is silent until the next tap. Same as the web
    // client, where the cue reads the pre-toggle setting too.
    feedback('tap');
    update((p) => toggleSound(p, now()));
  };

  const pressReset = (press: ResetPress) => {
    // A heavier thud for the destructive one, so the hand knows the two presses
    // are not the same kind of press.
    feedback(press === 'delete' ? 'lose' : 'tap');

    const step = nextReset(resetStage, press);
    setResetStage(step.stage);
    if (!step.wipe) return;

    const plan = startOverPlan(session?.signedIn === true);
    void (async () => {
      // Order is the whole safeguard for an account: sign out first so the
      // queued save lands on the server, then clear the device. Nothing here
      // asks the server to delete anything - `plan.deleteAccountCopy` is
      // permanently false, and there is no client call that could.
      if (plan.signOutFirst) await signOut();
      // `setProfile(null)` clears the device through `storage.ts`, the same
      // boundary every other write goes through. With no profile, `App.tsx`
      // renders sign-up rather than a dashboard with nothing in it - and going
      // home first means the child lands on Home, not back in Settings, once he
      // has picked a new starter.
      onBack();
      setProfile(null);
    })();
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{tr('settings')}</Text>

      <Panel>
        <Text style={styles.rowLabel}>{tr('language')}</Text>
        <View style={styles.choices}>
          {(['en', 'zh'] as const).map((option) => {
            const active = language === option;
            return (
              <Pressable
                key={option}
                testID={`lang-${option}`}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => chooseLanguage(option)}
                style={({ pressed }) => [
                  styles.choice,
                  active ? styles.choiceOn : styles.choiceOff,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.choiceText, active && styles.choiceTextOn]}>
                  {option === 'en' ? 'English' : '中文'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </Panel>

      <Panel>
        <Text style={styles.rowLabel}>{tr('sound')}</Text>
        <Pressable
          testID="toggle-sound"
          accessibilityRole="switch"
          accessibilityState={{ checked: profile.settings.sound }}
          onPress={flipSound}
          style={({ pressed }) => [
            styles.choice,
            profile.settings.sound ? styles.soundOn : styles.choiceOff,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.choiceText, profile.settings.sound && styles.choiceTextOn]}>
            {profile.settings.sound ? tr('on') : tr('off')}
          </Text>
        </Pressable>
      </Panel>

      <Panel>
        <Text style={styles.trainer}>{profile.trainerName}</Text>
        <Text style={styles.note}>{tr(saveStatus(session?.signedIn === true, syncState))}</Text>
      </Panel>

      <Panel>
        <Text style={styles.sectionTitle}>{tr('signIn')}</Text>
        {session?.signedIn ? (
          <>
            <Text style={styles.accountName}>
              {tr('savedToAccount')}
              {session.trainerName ? ` · ${session.trainerName}` : ''}
            </Text>
            <Button
              testID="sign-out"
              label={tr('signOut')}
              variant="secondary"
              onPress={() => void signOut()}
            />
          </>
        ) : (
          <>
            <Button testID="go-signin" label={tr('signInToSave')} onPress={onSignIn} />
          </>
        )}
      </Panel>

      <Panel>
        {resetStage === 'confirming' ? (
          <>
            <Text style={styles.warning}>{tr('confirmReset')}</Text>
            <View style={styles.choices}>
              <Pressable
                testID="reset-cancel"
                accessibilityRole="button"
                onPress={() => pressReset('back')}
                style={({ pressed }) => [
                  styles.choice,
                  styles.choiceOff,
                  pressed && styles.pressed,
                ]}
              >
                <Text style={styles.choiceText}>{tr('back')}</Text>
              </Pressable>
              <Pressable
                testID="reset-confirm"
                accessibilityRole="button"
                onPress={() => pressReset('delete')}
                style={({ pressed }) => [styles.choice, styles.danger, pressed && styles.pressed]}
              >
                <Text style={styles.dangerText}>{tr('deleteProgress')}</Text>
              </Pressable>
            </View>
          </>
        ) : (
          // Deliberately the quietest control on the screen, and the only one
          // that is not a filled button: nothing about it should invite a tap.
          <Pressable
            testID="start-over"
            accessibilityRole="button"
            onPress={() => pressReset('startOver')}
            style={({ pressed }) => [styles.quiet, pressed && styles.pressed]}
          >
            <Text style={styles.quietText}>{tr('startOver')}</Text>
          </Pressable>
        )}
      </Panel>

      <Button label={`← ${tr('goHome')}`} variant="ghost" onPress={onBack} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  accountName: { color: colors.text, fontSize: 15, fontWeight: '700' },
  syncNote: { color: colors.muted, fontSize: 13 },
  content: { padding: space.lg, paddingTop: 24, gap: space.md, paddingBottom: space.xl },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', textAlign: 'center' },
  rowLabel: { color: colors.text, fontSize: 17, fontWeight: '800' },
  choices: { flexDirection: 'row', gap: space.sm },
  choice: {
    flex: 1,
    minHeight: TAP,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
  },
  choiceOn: { backgroundColor: colors.gold },
  soundOn: { backgroundColor: colors.good },
  choiceOff: { backgroundColor: 'rgba(255,255,255,0.08)' },
  choiceText: { color: colors.text, fontSize: 17, fontWeight: '800' },
  choiceTextOn: { color: '#3b2500' },
  pressed: { opacity: 0.75, transform: [{ scale: 0.98 }] },
  trainer: { color: colors.text, fontSize: 17, fontWeight: '800' },
  note: { color: colors.muted, fontSize: 13, marginTop: -space.sm },
  // The one destructive control in the app, and the only place `colors.bad`
  // appears outside a losing health bar. It reads as a warning at a glance,
  // which is the point - a child should not have to read it to know.
  danger: { backgroundColor: colors.bad },
  dangerText: { color: '#3b0a14', fontSize: 17, fontWeight: '900' },
  warning: { color: colors.bad, fontSize: 15, fontWeight: '800', lineHeight: 21 },
  quiet: {
    minHeight: TAP,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
  },
  quietText: { color: colors.faint, fontSize: 14, fontWeight: '700' },
});
