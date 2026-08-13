import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { Language, Profile } from '../engine';
import { useGame } from '../game/GameContext';
import { TAP, colors, radius, space } from '../theme';
import { Button, Panel } from '../ui/kit';

/**
 * Settings: language and sound.
 *
 * The player is bilingual, and until this screen existed the language followed
 * whatever the profile was created with - a child who signed up in English had
 * no way back to Chinese short of deleting the save.
 *
 * The two transitions below are exported as pure functions taking the current
 * time as an argument, exactly like the engine's rules do, so `Settings.test.ts`
 * can assert what they change without a React renderer.
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

export function Settings({ profile, onBack }: { profile: Profile; onBack: () => void }) {
  const { language, tr, update, feedback } = useGame();

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
        <Text style={styles.note}>{tr('savedLocally')}</Text>
      </Panel>

      <Button label={`← ${tr('goHome')}`} variant="ghost" onPress={onBack} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
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
});
