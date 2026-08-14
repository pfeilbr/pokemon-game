import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  BADGES,
  MAX_TIER,
  SKILLS,
  SKILL_META,
  type Profile,
  accuracyOf,
  averageSeconds,
  overallAccuracy,
} from '../engine';
import { useGame } from '../game/GameContext';
import { colors, radius, space, tint } from '../theme';
import { Button, Panel, Stat } from '../ui/kit';

/**
 * Progress and maths statistics.
 *
 * The per-skill breakdown is here for the grown-up as much as the child: it is
 * the honest answer to "is this actually teaching him anything", broken down by
 * the skill the engine tagged each question with.
 */
export function ProgressScreen({ profile, onBack }: { profile: Profile; onBack: () => void }) {
  const { language, tr } = useGame();

  const earned = new Set(profile.badges);
  // Walked in the engine's own order, exactly as the web progress page does.
  // Reading the keys off the save instead put the rows in whatever order the
  // JSON happened to carry - which differs between a save made on this client,
  // one synced from the web, and one repaired by `normaliseProfile` - so the
  // same child could see his skills in two different orders on two devices.
  const practised = SKILLS.filter((skill) => (profile.skillStats[skill]?.attempts ?? 0) > 0);

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{tr('progressTitle')}</Text>

      <Panel>
        <View style={styles.statRow}>
          <Stat label={tr('battlesWon')} value={String(profile.battlesWon)} />
          <Stat label={tr('questionsAnswered')} value={String(profile.problemsTotal)} />
          <Stat label={tr('accuracy')} value={`${Math.round(overallAccuracy(profile) * 100)}%`} />
        </View>
      </Panel>

      <Panel>
        <Text style={styles.sectionTitle}>
          🧠 {tr('mathLevel')} {profile.tier} / {MAX_TIER}
        </Text>
        <View style={styles.tierTrack}>
          <View style={[styles.tierFill, { width: `${(profile.tier / MAX_TIER) * 100}%` }]} />
        </View>
      </Panel>

      <Panel>
        <Text style={styles.sectionTitle}>{tr('mathsBreakdown')}</Text>
        {practised.length === 0 ? (
          <Text style={styles.empty}>{tr('noDataYet')}</Text>
        ) : (
          practised.map((skill) => {
            const stat = profile.skillStats[skill];
            const accuracy = Math.round(accuracyOf(stat) * 100);
            return (
              <View key={skill} style={styles.skillRow}>
                <View style={styles.skillHead}>
                  <Text style={styles.skillName}>{SKILL_META[skill].label[language]}</Text>
                  <Text style={styles.skillMeta}>
                    {accuracy}% · {averageSeconds(stat).toFixed(1)}
                    {tr('seconds')}
                  </Text>
                </View>
                <View style={styles.skillTrack}>
                  <View
                    style={[
                      styles.skillFill,
                      {
                        width: `${accuracy}%`,
                        backgroundColor:
                          accuracy >= 80 ? colors.good : accuracy >= 50 ? colors.gold : colors.bad,
                      },
                    ]}
                  />
                </View>
              </View>
            );
          })
        )}
      </Panel>

      <Panel>
        <Text style={styles.sectionTitle}>
          {tr('badges')} · {earned.size}/{BADGES.length}
        </Text>
        <View style={styles.badgeGrid}>
          {BADGES.map((badge) => {
            const has = earned.has(badge.id);
            return (
              <View
                key={badge.id}
                testID={`badge-${badge.id}`}
                style={[styles.badge, has ? styles.badgeEarned : styles.badgeLocked]}
              >
                <Text style={[styles.badgeIcon, !has && { opacity: 0.3 }]}>{badge.icon}</Text>
                <Text style={[styles.badgeName, !has && { color: colors.faint }]}>
                  {has ? badge.name[language] : tr('locked')}
                </Text>
                {has && <Text style={styles.badgeDesc}>{badge.description[language]}</Text>}
              </View>
            );
          })}
        </View>
      </Panel>

      <Button label={`← ${tr('goHome')}`} variant="ghost" onPress={onBack} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: 24, gap: space.md, paddingBottom: space.xl },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', textAlign: 'center' },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '800' },
  statRow: { flexDirection: 'row' },
  empty: { color: colors.muted, fontSize: 14 },
  tierTrack: {
    height: 12,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(2,6,23,0.8)',
    overflow: 'hidden',
  },
  tierFill: { height: '100%', backgroundColor: colors.sky, borderRadius: radius.pill },
  skillRow: { gap: 4 },
  skillHead: { flexDirection: 'row', justifyContent: 'space-between' },
  skillName: { color: colors.text, fontSize: 14, fontWeight: '700', flexShrink: 1 },
  skillMeta: { color: colors.muted, fontSize: 13 },
  skillTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(2,6,23,0.8)',
    overflow: 'hidden',
  },
  skillFill: { height: '100%', borderRadius: radius.pill },
  badgeGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  badge: {
    width: '48%',
    borderRadius: radius.md,
    padding: space.sm,
    gap: 2,
    borderWidth: 1,
  },
  badgeEarned: { backgroundColor: tint(colors.gold, 0.13), borderColor: 'rgba(252,211,77,0.4)' },
  badgeLocked: { backgroundColor: 'rgba(255,255,255,0.03)', borderColor: colors.panelEdge },
  badgeIcon: { fontSize: 24 },
  badgeName: { color: colors.text, fontSize: 13, fontWeight: '800' },
  badgeDesc: { color: colors.muted, fontSize: 11, lineHeight: 15 },
});
