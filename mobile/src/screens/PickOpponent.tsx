import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ELEMENTS,
  ELEMENT_STYLE,
  NEUTRAL,
  SUPER_EFFECTIVE,
  type Profile,
  availableAtLevel,
  createRng,
  effectiveness,
  getCreature,
  levelFromXp,
  partnerFor,
  strongAgainst,
  weakTo,
} from '../engine';
import { useGame } from '../game/GameContext';
import { colors, radius, space, tint } from '../theme';
import { CreatureArt } from '../ui/CreatureArt';
import { Button, ElementChip, Panel } from '../ui/kit';

/** How many opponents to offer. Enough to choose between, few enough to scan. */
const OPPONENT_COUNT = 3;

/**
 * Opponent selection.
 *
 * The counter-pick is the strategy layer of this game, so the matchup verdict
 * is stated outright on each card and the full wheel is one tap away. The child
 * this was built for plays chess; planning the matchup should be possible
 * before the fight, not discoverable only by losing one.
 */
export function PickOpponent({
  profile,
  onChoose,
  onBack,
}: {
  profile: Profile;
  onChoose: (opponentId: string) => void;
  onBack: () => void;
}) {
  const { language, tr, feedback } = useGame();
  const [showChart, setShowChart] = useState(false);

  const partner = getCreature(partnerFor(profile));
  const level = levelFromXp(profile.xp);

  // Deterministic per battle, so backing out and returning offers the same
  // three choices - but it rerolls as the player levels and after each fight.
  const rng = createRng(
    `${profile.trainerName}:${profile.battlesWon + profile.battlesLost}:${level}`,
  );
  const pool = availableAtLevel(level).filter((c) => c.id !== partner.id);
  const opponents = rng.shuffle(pool).slice(0, OPPONENT_COUNT);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{tr('pickOpponent')}</Text>
      <Text style={styles.sub}>{tr('pickOpponentSub')}</Text>

      <Panel style={styles.youRow}>
        <Text style={styles.youLabel}>{tr('yourType')}</Text>
        <CreatureArt creature={partner} size={48} />
        <Text style={styles.youName}>{partner.name[language]}</Text>
        <ElementChip
          element={partner.element}
          label={ELEMENT_STYLE[partner.element].label[language]}
        />
      </Panel>

      {opponents.map((foe) => {
        const style = ELEMENT_STYLE[foe.element];
        const attacking = effectiveness(partner.element, foe.element);
        const defending = effectiveness(foe.element, partner.element);

        // Net advantage, so the label reflects the whole exchange rather than
        // only the player's own damage.
        const verdict =
          attacking > defending
            ? { text: tr('goodMatchup'), tone: colors.good, icon: '▲' }
            : attacking < defending
              ? { text: tr('badMatchup'), tone: colors.bad, icon: '▼' }
              : { text: tr('evenMatchup'), tone: colors.muted, icon: '=' };

        return (
          <Pressable
            key={foe.id}
            testID={`opponent-${foe.id}`}
            accessibilityRole="button"
            onPress={() => {
              feedback('tap');
              onChoose(foe.id);
            }}
            style={({ pressed }) => [
              styles.foeCard,
              { backgroundColor: tint(style.color, 0.13) },
              pressed && { opacity: 0.8 },
            ]}
          >
            <CreatureArt creature={foe} size={88} />
            <View style={styles.foeInfo}>
              <Text style={styles.foeName}>{foe.name[language]}</Text>
              <ElementChip element={foe.element} label={style.label[language]} />
              <Text style={[styles.verdict, { color: verdict.tone }]}>
                {verdict.icon} {verdict.text}
              </Text>
              <Text style={styles.multipliers}>
                {attacking === SUPER_EFFECTIVE ? '⚔️ ×2  ' : attacking < NEUTRAL ? '⚔️ ×0.5  ' : ''}
                {defending === SUPER_EFFECTIVE ? '🛡️ ×2' : defending < NEUTRAL ? '🛡️ ×0.5' : ''}
              </Text>
            </View>
          </Pressable>
        );
      })}

      <Panel>
        <Pressable
          testID="toggle-type-chart"
          accessibilityRole="button"
          onPress={() => setShowChart((v) => !v)}
          style={styles.chartToggle}
        >
          <Text style={styles.chartTitle}>🔄 {tr('typeChart')}</Text>
          <Text style={styles.chartSign}>{showChart ? '−' : '+'}</Text>
        </Pressable>

        {showChart &&
          ELEMENTS.map((element) => {
            const style = ELEMENT_STYLE[element];
            return (
              <View
                key={element}
                style={[styles.chartRow, { backgroundColor: tint(style.color, 0.1) }]}
              >
                <Text style={[styles.chartElement, { color: style.color }]}>
                  {style.icon} {style.label[language]}
                </Text>
                <Text style={styles.chartRelation}>
                  <Text style={{ color: colors.good }}>▲ </Text>
                  {strongAgainst(element)
                    .map((e) => ELEMENT_STYLE[e].icon)
                    .join(' ')}
                  {'   '}
                  <Text style={{ color: colors.bad }}>▼ </Text>
                  {weakTo(element)
                    .map((e) => ELEMENT_STYLE[e].icon)
                    .join(' ')}
                </Text>
              </View>
            );
          })}
      </Panel>

      <Button label={`← ${tr('goHome')}`} variant="ghost" onPress={onBack} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: 24, gap: space.md, paddingBottom: space.xl },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', textAlign: 'center' },
  sub: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  youRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  youLabel: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  youName: { color: colors.text, fontSize: 16, fontWeight: '800', flexShrink: 1 },
  foeCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.panelEdge,
  },
  foeInfo: { flex: 1, gap: 5 },
  foeName: { color: colors.text, fontSize: 19, fontWeight: '900' },
  verdict: { fontSize: 15, fontWeight: '800' },
  multipliers: { color: colors.faint, fontSize: 13 },
  chartToggle: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chartTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  chartSign: { color: colors.muted, fontSize: 24 },
  chartRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
  },
  chartElement: { fontSize: 14, fontWeight: '800', width: 86 },
  chartRelation: { color: colors.muted, fontSize: 14 },
});
