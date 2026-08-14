import { ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ELEMENT_STYLE,
  STRINGS,
  type Profile,
  completion,
  getCreature,
  levelProgress,
  nextEvolutionLevel,
  partnerFor,
} from '../engine';
import { useGame } from '../game/GameContext';
import { colors, space } from '../theme';
import { CreatureArt } from '../ui/CreatureArt';
import { Button, ElementChip, Panel, Stat, XpBar } from '../ui/kit';

/**
 * The dashboard.
 *
 * Answers the three questions a child actually has on opening the app: how am I
 * doing, what does my partner look like now, and where is the battle button.
 */
export function Home({
  profile,
  onBattle,
  onAlbum,
  onProgress,
  onSettings,
}: {
  profile: Profile;
  onBattle: () => void;
  onAlbum: () => void;
  onProgress: () => void;
  onSettings: () => void;
}) {
  const { language, tr, feedback } = useGame();

  const partner = getCreature(partnerFor(profile));
  const style = ELEMENT_STYLE[partner.element];
  const progress = levelProgress(profile.xp);
  const evolvesAt = nextEvolutionLevel(profile);

  const go = (fn: () => void) => () => {
    feedback('tap');
    fn();
  };

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <View>
        <Text style={styles.hello}>
          {tr('hello')}, {profile.trainerName}
        </Text>
        <Text style={styles.app}>{STRINGS.appName[language]}</Text>
      </View>

      <Panel glow={style.color}>
        <Text style={styles.cardLabel}>{tr('partner')}</Text>
        <View style={styles.partnerRow}>
          <CreatureArt creature={partner} language={language} size={104} />
          <View style={styles.partnerInfo}>
            <Text style={styles.partnerName}>{partner.name[language]}</Text>
            <ElementChip element={partner.element} label={style.label[language]} />
            <Text style={styles.evolveHint}>
              {evolvesAt ? `${tr('evolvesAt')} ${evolvesAt}` : tr('finalForm')}
            </Text>
          </View>
        </View>
        <XpBar
          into={progress.into}
          span={progress.span}
          level={progress.level}
          language={language}
        />
      </Panel>

      <Panel>
        <View style={styles.statRow}>
          <Stat label={tr('mathLevel')} value={String(profile.tier)} />
          <Stat label={tr('streak')} value={String(profile.streak.current)} />
          <Stat label={tr('caught')} value={`${Math.round(completion(profile) * 100)}%`} />
        </View>
      </Panel>

      <View style={styles.actions}>
        <Button testID="go-battle" label={`⚔️  ${tr('battle')}`} onPress={go(onBattle)} />
        <Button
          testID="go-album"
          label={`📗  ${tr('album')}`}
          variant="secondary"
          onPress={go(onAlbum)}
        />
        <Button
          testID="go-progress"
          label={`🏅  ${tr('progress')}`}
          variant="secondary"
          onPress={go(onProgress)}
        />
        <Button
          testID="go-settings"
          label={`⚙️  ${tr('settings')}`}
          variant="secondary"
          onPress={go(onSettings)}
        />
      </View>

      <Text style={styles.footer}>{tr('savedLocally')}</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: 24, gap: space.md, paddingBottom: space.xl },
  hello: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  app: { color: colors.text, fontSize: 26, fontWeight: '900' },
  cardLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  partnerRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  partnerInfo: { flex: 1, gap: 6 },
  partnerName: { color: colors.text, fontSize: 22, fontWeight: '900' },
  evolveHint: { color: colors.muted, fontSize: 13 },
  statRow: { flexDirection: 'row' },
  actions: { gap: space.sm, marginTop: space.xs },
  footer: { color: colors.faint, fontSize: 12, textAlign: 'center', marginTop: space.md },
});
