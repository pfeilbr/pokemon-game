import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  CREATURES,
  ELEMENTS,
  ELEMENT_STYLE,
  type Creature,
  type Element,
  type Profile,
  getCreature,
} from '../engine';
import { useGame } from '../game/GameContext';
import { colors, radius, space, tint } from '../theme';
import { CreatureArt } from '../ui/CreatureArt';
import { Button, ElementChip, Panel } from '../ui/kit';

export type ElementGroup = { element: Element; creatures: Creature[] };

/**
 * Splits the roster into one section per element, in wheel order.
 *
 * The roster is 36 creatures. Flat, that is a wall a seven-year-old scrolls
 * past rather than reads; grouped, it is six short shelves he can point at. The
 * web album has always done this, so this also stops the two clients teaching
 * two different mental models of the same collection.
 *
 * Pure and exported on purpose. Buried in JSX, "every creature appears exactly
 * once" is only checkable by rendering the screen — and a creature dropped from
 * an album looks exactly like one that has not been caught yet, which is the
 * kind of bug that never gets reported. `Album.test.ts` walks this function.
 *
 * Elements with nothing in them are left out rather than given an empty header.
 */
export function groupByElement(creatures: readonly Creature[] = CREATURES): ElementGroup[] {
  const groups: ElementGroup[] = [];

  for (const element of ELEMENTS) {
    // Filtering per element preserves roster order within a group, which keeps
    // each evolution line reading root-first.
    const members = creatures.filter((creature) => creature.element === element);
    if (members.length > 0) groups.push({ element, creatures: members });
  }

  return groups;
}

/**
 * The album.
 *
 * Un-caught creatures are shown as greyed silhouettes rather than hidden, so
 * the collection reads as a set with gaps in it. Knowing what is missing is
 * most of why a child keeps playing.
 */
export function Album({ profile, onBack }: { profile: Profile; onBack: () => void }) {
  const { language, tr, feedback } = useGame();
  const [selected, setSelected] = useState<string | null>(null);

  const caught = new Set(profile.caught);
  const detail = selected ? getCreature(selected) : null;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={styles.title}>{tr('albumTitle')}</Text>
      <Text style={styles.sub}>
        {caught.size} / {CREATURES.length}
      </Text>

      {detail && (
        <Panel glow={ELEMENT_STYLE[detail.element].color} style={styles.detail}>
          <CreatureArt
            creature={detail}
            language={language}
            size={110}
            silhouette={!caught.has(detail.id)}
          />
          <Text style={styles.detailName}>
            {caught.has(detail.id) ? detail.name[language] : '???'}
          </Text>
          <ElementChip
            element={detail.element}
            label={ELEMENT_STYLE[detail.element].label[language]}
          />
          <Text style={styles.detailMeta}>
            {tr('stage')} {detail.stage}
          </Text>
          <Text style={styles.flavor}>
            {caught.has(detail.id) ? detail.flavor[language] : tr('notCaughtYet')}
          </Text>
        </Panel>
      )}

      {groupByElement().map((group) => (
        <View key={group.element} style={styles.section}>
          <View style={styles.sectionHeader}>
            <ElementChip
              element={group.element}
              label={ELEMENT_STYLE[group.element].label[language]}
            />
            <Text style={styles.sectionCount}>
              {group.creatures.filter((creature) => caught.has(creature.id)).length} /{' '}
              {group.creatures.length}
            </Text>
          </View>

          <View style={styles.grid}>
            {group.creatures.map((creature) => {
              const owned = caught.has(creature.id);
              const style = ELEMENT_STYLE[creature.element];
              return (
                <Pressable
                  key={creature.id}
                  testID={`album-${creature.id}`}
                  accessibilityRole="button"
                  accessibilityLabel={owned ? creature.name[language] : tr('notCaughtYet')}
                  onPress={() => {
                    feedback('tap');
                    setSelected((current) => (current === creature.id ? null : creature.id));
                  }}
                  style={({ pressed }) => [
                    styles.cell,
                    { backgroundColor: owned ? tint(style.color, 0.13) : 'rgba(255,255,255,0.03)' },
                    selected === creature.id && { borderColor: style.color, borderWidth: 2 },
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <CreatureArt
                    creature={creature}
                    language={language}
                    size={64}
                    silhouette={!owned}
                  />
                  <Text
                    style={[styles.cellName, !owned && styles.cellNameLocked]}
                    numberOfLines={1}
                  >
                    {owned ? creature.name[language] : '???'}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      ))}

      <Button label={`← ${tr('goHome')}`} variant="ghost" onPress={onBack} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, paddingTop: 24, gap: space.md, paddingBottom: space.xl },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', textAlign: 'center' },
  sub: { color: colors.muted, fontSize: 15, textAlign: 'center', fontWeight: '700' },
  detail: { alignItems: 'center' },
  detailName: { color: colors.text, fontSize: 22, fontWeight: '900' },
  detailMeta: { color: colors.muted, fontSize: 13 },
  flavor: { color: colors.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  section: { gap: space.sm },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  sectionCount: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  cell: {
    width: '31.5%',
    alignItems: 'center',
    paddingVertical: space.sm,
    gap: 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.panelEdge,
  },
  cellName: { color: colors.text, fontSize: 12, fontWeight: '700' },
  cellNameLocked: { color: colors.faint },
});
