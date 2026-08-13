import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { ELEMENT_STYLE, createProfile, starters } from '../engine';
import { useGame } from '../game/GameContext';
import { colors, radius, space, tint } from '../theme';
import { CreatureArt } from '../ui/CreatureArt';
import { Button, ElementChip } from '../ui/kit';

/**
 * Sign-up: a name and a first partner.
 *
 * Two steps rather than one form. A seven-year-old picking a starter is the
 * best moment in the game and deserves the whole screen, and splitting it means
 * the keyboard is never up at the same time as the six creatures.
 */
export function Onboarding() {
  const { language, tr, setProfile, feedback } = useGame();
  const [name, setName] = useState('');
  const [starterId, setStarterId] = useState<string | null>(null);
  const [step, setStep] = useState<'name' | 'partner'>('name');

  const trimmed = name.trim();
  const nameOk = trimmed.length >= 2;

  if (step === 'name') {
    return (
      <ScrollView contentContainerStyle={styles.centered} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Mathmon Battle League</Text>
        <Text style={styles.subtitle}>{tr('tagline')}</Text>

        <Text style={styles.question}>{tr('chooseName')}</Text>
        <TextInput
          testID="trainer-name"
          value={name}
          onChangeText={setName}
          placeholder={tr('namePlaceholder')}
          placeholderTextColor={colors.faint}
          style={styles.input}
          autoCorrect={false}
          maxLength={16}
          returnKeyType="done"
          onSubmitEditing={() => nameOk && setStep('partner')}
        />
        {name.length > 0 && !nameOk && <Text style={styles.error}>{tr('nameTooShort')}</Text>}

        <View style={styles.actions}>
          <Button
            testID="to-partner"
            label={tr('next')}
            disabled={!nameOk}
            onPress={() => {
              feedback('tap');
              setStep('partner');
            }}
          />
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.question}>{tr('choosePartner')}</Text>

      <View style={styles.starterGrid}>
        {starters().map((creature) => {
          const style = ELEMENT_STYLE[creature.element];
          const chosen = starterId === creature.id;
          return (
            <Pressable
              key={creature.id}
              testID={`starter-${creature.id}`}
              accessibilityRole="button"
              accessibilityState={{ selected: chosen }}
              onPress={() => {
                feedback('tap');
                setStarterId(creature.id);
              }}
              style={[
                styles.starter,
                { backgroundColor: tint(style.color, 0.14) },
                chosen && { borderColor: style.color, borderWidth: 3 },
              ]}
            >
              <CreatureArt creature={creature} size={92} />
              <Text style={styles.starterName}>{creature.name[language]}</Text>
              <ElementChip element={creature.element} label={style.label[language]} />
            </Pressable>
          );
        })}
      </View>

      {starterId && (
        <Text style={styles.flavor}>
          {starters().find((c) => c.id === starterId)?.flavor[language]}
        </Text>
      )}

      <View style={styles.actions}>
        <Button
          testID="start-adventure"
          label={tr('startAdventure')}
          disabled={!starterId}
          onPress={() => {
            if (!starterId) return;
            feedback('win');
            setProfile(createProfile({ trainerName: trimmed, starterId, language }));
          }}
        />
        <Button label={tr('back')} variant="ghost" onPress={() => setStep('name')} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  centered: { padding: space.xl, paddingTop: 72, gap: space.md },
  content: { padding: space.lg, paddingTop: 60, gap: space.lg },
  title: { color: colors.text, fontSize: 32, fontWeight: '900' },
  subtitle: { color: colors.muted, fontSize: 15, marginBottom: space.xl },
  question: { color: colors.text, fontSize: 22, fontWeight: '800' },
  input: {
    minHeight: 60,
    borderRadius: radius.md,
    backgroundColor: colors.panel,
    borderWidth: 2,
    borderColor: colors.panelEdge,
    paddingHorizontal: space.lg,
    color: colors.text,
    fontSize: 22,
    fontWeight: '700',
  },
  error: { color: colors.bad, fontSize: 14, fontWeight: '700' },
  actions: { gap: space.sm, marginTop: space.lg },
  starterGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.md, justifyContent: 'center' },
  starter: {
    width: '47%',
    alignItems: 'center',
    gap: 6,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.panelEdge,
  },
  starterName: { color: colors.text, fontSize: 17, fontWeight: '800' },
  flavor: { color: colors.muted, fontSize: 15, textAlign: 'center', lineHeight: 22 },
});
