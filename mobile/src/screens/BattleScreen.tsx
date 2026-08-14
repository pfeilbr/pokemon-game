import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  CRIT_THRESHOLD,
  ELEMENT_STYLE,
  MAX_CHARGE,
  MAX_SPEED_BONUS,
  NEUTRAL,
  SUPER_EFFECTIVE,
  type BattleOutcome,
  type BattleState,
  type Profile,
  applyBattleResult,
  availableMoves,
  badgeById,
  battleReducer,
  createBattle,
  effectiveness,
  getCreature,
  levelFromXp,
  partnerFor,
  speedFraction,
  summarise,
} from '../engine';
import { useGame } from '../game/GameContext';
import { TAP, colors, radius, space, tint } from '../theme';
import { CreatureArt } from '../ui/CreatureArt';
import { Keypad } from '../ui/Keypad';
import { Button, ChargeMeter, ElementChip, HealthBar, Panel, Stat } from '../ui/kit';

/**
 * The battle screen.
 *
 * Owns timing and presentation only; every rule lives in the shared battle
 * reducer, which is fed the clock explicitly. That is what lets the same fight
 * be replayed exactly in a test at the repository root.
 */

/** How long the hit message stays up before the next turn. */
const RESOLVE_MS = 1500;

export function BattleScreen({
  profile,
  opponentId,
  onExit,
  onHome,
}: {
  profile: Profile;
  opponentId: string;
  onExit: () => void;
  onHome: () => void;
}) {
  const { language, tr, update, feedback } = useGame();

  const level = levelFromXp(profile.xp);
  const partnerId = partnerFor(profile);

  const [state, dispatch] = useReducer(battleReducer, null, () =>
    createBattle({
      // Seeded from the battle count so each fight differs, but re-rendering
      // mid-fight never reshuffles the questions.
      seed: `${profile.trainerName}:${profile.battlesWon + profile.battlesLost}:${opponentId}`,
      playerCreatureId: partnerId,
      foeCreatureId: opponentId,
      playerLevel: level,
      foeLevel: level,
      tier: profile.tier,
    }),
  );

  const [answer, setAnswer] = useState('');
  const [outcome, setOutcome] = useState<BattleOutcome | null>(null);
  const recorded = useRef(false);

  const player = getCreature(state.player.creatureId);
  const foe = getCreature(state.foe.creatureId);
  const lastEntry = state.log[state.log.length - 1];

  // Start the catch clock only once its screen is actually on show, so the
  // speed of the catch answer is measured from when the player could see it.
  useEffect(() => {
    if (state.phase === 'catching' && state.problemShownAt === null) {
      dispatch({ type: 'beginCatch', now: Date.now() });
    }
  }, [state.phase, state.problemShownAt]);

  // Auto-advance out of the resolve message.
  useEffect(() => {
    if (state.phase !== 'resolving') return;
    const timer = setTimeout(() => dispatch({ type: 'continue' }), RESOLVE_MS);
    return () => clearTimeout(timer);
  }, [state.phase, state.turn]);

  // Fold the finished battle into the profile exactly once.
  useEffect(() => {
    if (state.phase !== 'victory' && state.phase !== 'defeat') return;
    if (recorded.current) return;
    recorded.current = true;

    const summary = summarise(state);
    const result = applyBattleResult(profile, summary, state.attempts);
    setOutcome(result);
    update(() => result.profile);
    feedback(summary.won ? 'win' : 'lose');
  }, [state, profile, update, feedback]);

  const submit = useCallback(() => {
    if (answer === '') return;
    const value = Number(answer);
    feedback(state.problem?.answer === value ? 'correct' : 'wrong');
    dispatch({ type: 'answer', value, now: Date.now() });
    setAnswer('');
  }, [answer, state.problem, feedback]);

  if (state.phase === 'victory' || state.phase === 'defeat') {
    return <VictoryScreen state={state} outcome={outcome} onExit={onExit} onHome={onHome} />;
  }

  const solving = state.phase === 'solving' || state.phase === 'catching';
  const isCatch = state.phase === 'catching';
  const moves = availableMoves(state);
  const struck =
    lastEntry?.kind === 'playerHit' || lastEntry?.kind === 'playerGlance'
      ? 'foe'
      : lastEntry?.kind === 'foeHit'
        ? 'player'
        : null;

  return (
    <ScrollView contentContainerStyle={styles.content} testID="battle">
      {/* Opponent */}
      <Panel glow={ELEMENT_STYLE[foe.element].color}>
        <View style={styles.fighterRow}>
          <View style={styles.fighterInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.fighterName}>{foe.name[language]}</Text>
              <ElementChip
                element={foe.element}
                label={ELEMENT_STYLE[foe.element].label[language]}
              />
            </View>
            <HealthBar current={state.foe.hp} max={state.foe.maxHp} />
          </View>
          <Shake trigger={struck === 'foe' ? state.log.length : 0}>
            <CreatureArt creature={foe} language={language} size={88} facing="left" />
          </Shake>
        </View>
        <MatchupHint attacker={player.element} defender={foe.element} />
      </Panel>

      {/* Problem or message */}
      {solving && state.problem ? (
        <View style={[styles.problemCard, isCatch && styles.catchCard]}>
          <Text style={styles.problemLabel}>{isCatch ? tr('catchPrompt') : tr('answer')}</Text>
          <Text testID="problem" style={styles.problemText}>
            {state.problem.prompt}
          </Text>
          {state.problemShownAt !== null && (
            <SpeedMeter
              key={state.problemShownAt}
              startedAt={state.problemShownAt}
              parSeconds={state.problem.parTime}
            />
          )}
        </View>
      ) : (
        <BattleMessage state={state} />
      )}

      {/* Player */}
      <Panel glow={ELEMENT_STYLE[player.element].color}>
        <View style={styles.fighterRow}>
          <Shake trigger={struck === 'player' ? state.log.length : 0}>
            <CreatureArt creature={player} language={language} size={88} />
          </Shake>
          <View style={styles.fighterInfo}>
            <View style={styles.nameRow}>
              <Text style={styles.fighterName}>{player.name[language]}</Text>
              <ElementChip
                element={player.element}
                label={ELEMENT_STYLE[player.element].label[language]}
              />
            </View>
            <HealthBar current={state.player.hp} max={state.player.maxHp} />
            <View style={styles.chargeRow}>
              <ChargeMeter charge={state.charge} max={MAX_CHARGE} label={tr('charge')} />
              {state.combo > 1 && (
                <Text style={styles.combo}>
                  {tr('combo')} ×{state.combo}
                </Text>
              )}
            </View>
          </View>
        </View>
      </Panel>

      {/* Actions */}
      {state.phase === 'choosing' && (
        <View style={styles.moveGrid}>
          {moves.map((move) => (
            <Pressable
              key={move.id}
              testID={`move-${move.kind}`}
              accessibilityRole="button"
              disabled={!move.affordable}
              onPress={() => {
                feedback('tap');
                setAnswer('');
                dispatch({ type: 'chooseMove', moveId: move.id, now: Date.now() });
              }}
              style={({ pressed }) => [
                styles.move,
                move.kind === 'mend' && styles.moveMend,
                move.kind === 'special' && styles.moveSpecial,
                // The special is the answer to a bad matchup, so make it
                // impossible to miss the moment it is actually usable.
                move.chargeCost > 0 && move.affordable && styles.moveReady,
                !move.affordable && styles.moveLocked,
                pressed && { opacity: 0.75 },
              ]}
            >
              <Text style={styles.moveName}>{move.name[language]}</Text>
              <Text style={styles.moveDesc}>{move.description[language]}</Text>
              {move.chargeCost > 0 && (
                <Text style={styles.moveCost}>
                  ⚡ {move.chargeCost}/{MAX_CHARGE}
                </Text>
              )}
            </Pressable>
          ))}
        </View>
      )}

      {solving && (
        <Keypad
          value={answer}
          onChange={setAnswer}
          onSubmit={submit}
          submitLabel={isCatch ? tr('catchIt') : tr('submit')}
          clearLabel={tr('clear')}
          onKeyPress={() => feedback('tap')}
        />
      )}

      {state.phase === 'resolving' && (
        <Button
          testID="continue-turn"
          label={`${tr('continue')} →`}
          variant="secondary"
          onPress={() => dispatch({ type: 'continue' })}
        />
      )}

      <Button label={tr('back')} variant="ghost" onPress={onExit} />
    </ScrollView>
  );
}

/**
 * The speed meter.
 *
 * The engine pays up to +30% damage for a fast answer and flags a critical hit
 * above a threshold. None of that used to be visible, so a child saw "Critical
 * hit!" on some turns and "Correct!" on others with no idea why.
 *
 * Deliberately pure upside: when it empties nothing bad happens, the hit is
 * simply normal, and the label says "take your time" rather than counting down.
 * There is no timeout anywhere in this screen.
 */
function SpeedMeter({ startedAt, parSeconds }: { startedAt: number; parSeconds: number }) {
  const { tr } = useGame();
  const [fraction, setFraction] = useState(1);

  useEffect(() => {
    const id = setInterval(() => {
      setFraction(speedFraction(Date.now() - startedAt, parSeconds));
    }, 100);
    return () => clearInterval(id);
  }, [startedAt, parSeconds]);

  // speedMultiplier = 1 + MAX_SPEED_BONUS * fraction, and a hit is critical at
  // CRIT_THRESHOLD, so the crit zone is everything above this fraction.
  const critFrom = (CRIT_THRESHOLD - 1) / MAX_SPEED_BONUS;
  const bonusPercent = Math.round(MAX_SPEED_BONUS * fraction * 100);
  const crit = fraction >= critFrom;

  return (
    <View style={styles.meterWrap} testID="speed-meter">
      <View style={styles.meterLabels}>
        {bonusPercent > 0 ? (
          <>
            <Text style={[styles.meterLabel, crit && { color: colors.gold }]}>
              {crit ? '⚡ ' : ''}
              {tr('speedBonus')}
            </Text>
            <Text style={styles.meterLabel}>+{bonusPercent}%</Text>
          </>
        ) : (
          <Text style={[styles.meterLabel, { color: colors.faint }]}>{tr('takeYourTime')}</Text>
        )}
      </View>
      <View style={styles.meterTrack}>
        <View
          style={[
            styles.meterFill,
            { width: `${fraction * 100}%`, backgroundColor: crit ? colors.gold : colors.sky },
          ]}
        />
      </View>
    </View>
  );
}

/**
 * A short shake when a fighter is hit.
 *
 * Honours Reduce Motion, which the web client gets for free from a global CSS
 * rule. On iOS it has to be asked for explicitly, so a child who needs calmer
 * visuals gets the damage numbers without the jolt.
 */
function Shake({ trigger, children }: { trigger: number; children: React.ReactNode }) {
  const offset = useRef(new Animated.Value(0)).current;
  const [reduceMotion, setReduceMotion] = useState(false);

  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (!trigger || reduceMotion) return;
    Animated.sequence([
      Animated.timing(offset, { toValue: -8, duration: 60, useNativeDriver: true }),
      Animated.timing(offset, { toValue: 8, duration: 60, useNativeDriver: true }),
      Animated.timing(offset, { toValue: 0, duration: 90, useNativeDriver: true }),
    ]).start();
  }, [trigger, reduceMotion, offset]);

  return <Animated.View style={{ transform: [{ translateX: offset }] }}>{children}</Animated.View>;
}

function MatchupHint({
  attacker,
  defender,
}: {
  attacker: Parameters<typeof effectiveness>[0];
  defender: Parameters<typeof effectiveness>[1];
}) {
  const { tr } = useGame();
  const multiplier = effectiveness(attacker, defender);
  if (multiplier === NEUTRAL) return null;

  const good = multiplier === SUPER_EFFECTIVE;
  return (
    <Text style={[styles.matchup, { color: good ? colors.good : colors.bad }]}>
      {good ? `✨ ${tr('superEffective')}` : `🛡️ ${tr('notVeryEffective')}`}
    </Text>
  );
}

function BattleMessage({ state }: { state: BattleState }) {
  const { tr } = useGame();
  const entry = state.log[state.log.length - 1];

  if (!entry) {
    return (
      <View style={styles.messageCard}>
        <Text style={styles.messageTitle}>{tr('wildAppeared')}</Text>
        <Text style={styles.messageSub}>{tr('chooseMove')}</Text>
      </View>
    );
  }

  if (entry.kind === 'playerGlance') {
    return (
      <View style={styles.messageCard}>
        <Text style={[styles.messageTitle, { color: colors.bad }]}>{tr('wrong')}</Text>
        <Text style={styles.messageSub}>
          {tr('theAnswerWas')} {entry.correctAnswer}
        </Text>
      </View>
    );
  }

  if (entry.kind === 'playerHit') {
    return (
      <View style={styles.messageCard}>
        <Text style={[styles.messageTitle, { color: colors.good }]}>
          {entry.crit ? `⚡ ${tr('critical')}` : tr('correct')}
        </Text>
        <Text style={styles.damage}>−{entry.amount}</Text>
      </View>
    );
  }

  if (entry.kind === 'playerMend') {
    return (
      <View style={styles.messageCard}>
        <Text style={[styles.damage, { color: colors.good }]}>+{entry.amount}</Text>
      </View>
    );
  }

  if (entry.kind === 'foeHit') {
    return (
      <View style={styles.messageCard}>
        <Text style={[styles.damage, { color: colors.bad }]}>−{entry.amount}</Text>
      </View>
    );
  }

  return (
    <View style={styles.messageCard}>
      <Text style={styles.messageSub}>{tr('chooseMove')}</Text>
    </View>
  );
}

function VictoryScreen({
  state,
  outcome,
  onExit,
  onHome,
}: {
  state: BattleState;
  outcome: BattleOutcome | null;
  onExit: () => void;
  onHome: () => void;
}) {
  const { language, tr } = useGame();
  const summary = summarise(state);
  const foe = getCreature(state.foe.creatureId);

  return (
    <ScrollView contentContainerStyle={styles.content} testID="battle-result">
      <Text style={[styles.resultTitle, { color: summary.won ? colors.gold : colors.muted }]}>
        {summary.won ? `🎉 ${tr('youWin')}` : tr('youLost')}
      </Text>

      {summary.won && (
        <Panel style={styles.caughtPanel}>
          <CreatureArt creature={foe} language={language} size={120} />
          <Text style={[styles.caughtText, { color: summary.caught ? colors.good : colors.muted }]}>
            {summary.caught ? `✨ ${tr('gotIt')}` : tr('itEscaped')}
          </Text>
          <Text style={styles.messageSub}>{foe.name[language]}</Text>
        </Panel>
      )}

      <Panel>
        <View style={styles.statRow}>
          <Stat label={tr('xpEarned')} value={`+${outcome?.xpGained ?? 0}`} />
          <Stat
            label={tr('accuracy')}
            value={`${summary.total > 0 ? Math.round((summary.correct / summary.total) * 100) : 0}%`}
          />
          <Stat label={tr('bestCombo')} value={`×${summary.bestCombo}`} />
        </View>
      </Panel>

      {outcome?.leveledUp && (
        <Text style={[styles.celebrate, { color: colors.gold }]}>
          🌟 {tr('levelUp')} → {outcome.newLevel}
        </Text>
      )}
      {outcome?.evolved && (
        <Text style={[styles.celebrate, { color: colors.sky }]}>
          ✨ {getCreature(partnerFor(outcome.profile)).name[language]} — {tr('evolvedInto')}!
        </Text>
      )}
      {outcome && outcome.tierChanged > 0 && (
        <Text style={[styles.celebrate, { color: colors.good }]}>🧠 {tr('mathLevelUp')}</Text>
      )}

      {/* Name the badges rather than just announcing that some arrived. */}
      {outcome?.newBadges.map((id) => {
        const badge = badgeById(id);
        if (!badge) return null;
        return (
          <View key={id} testID={`new-badge-${id}`} style={styles.badgeRow}>
            <Text style={styles.badgeIcon}>{badge.icon}</Text>
            <View style={{ flex: 1 }}>
              <Text style={styles.badgeEyebrow}>{tr('newBadge')}</Text>
              <Text style={styles.badgeName}>{badge.name[language]}</Text>
            </View>
          </View>
        );
      })}

      <Button testID="play-again" label={tr('playAgain')} onPress={onExit} />
      <Button label={tr('goHome')} variant="ghost" onPress={onHome} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.md, paddingTop: 20, gap: space.sm, paddingBottom: space.xl },
  fighterRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  fighterInfo: { flex: 1, gap: 6 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, flexWrap: 'wrap' },
  fighterName: { color: colors.text, fontSize: 17, fontWeight: '900' },
  chargeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: space.sm,
  },
  combo: {
    color: colors.gold,
    fontSize: 14,
    fontWeight: '900',
    backgroundColor: 'rgba(251,191,36,0.18)',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  matchup: { textAlign: 'center', fontSize: 14, fontWeight: '800' },
  problemCard: {
    backgroundColor: colors.panel,
    borderColor: colors.panelEdge,
    borderWidth: 1,
    borderRadius: radius.lg,
    padding: space.md,
    alignItems: 'center',
    gap: 4,
  },
  catchCard: { backgroundColor: 'rgba(52,211,153,0.12)' },
  problemLabel: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  problemText: { color: colors.text, fontSize: 44, fontWeight: '900', textAlign: 'center' },
  meterWrap: { width: '100%', maxWidth: 320, marginTop: space.sm },
  meterLabels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  meterLabel: { color: '#cbd5e1', fontSize: 12, fontWeight: '800' },
  meterTrack: {
    height: 8,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(2,6,23,0.8)',
    overflow: 'hidden',
  },
  meterFill: { height: '100%', borderRadius: radius.pill },
  messageCard: {
    backgroundColor: colors.panel,
    borderColor: colors.panelEdge,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingVertical: space.lg,
    alignItems: 'center',
    gap: 2,
  },
  messageTitle: { color: colors.text, fontSize: 19, fontWeight: '900' },
  messageSub: { color: colors.muted, fontSize: 14 },
  damage: { color: colors.text, fontSize: 30, fontWeight: '900' },
  moveGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  move: {
    width: '48.5%',
    minHeight: TAP + 20,
    borderRadius: radius.md,
    padding: space.md,
    gap: 2,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
  },
  moveMend: { backgroundColor: 'rgba(16,185,129,0.15)', borderColor: 'rgba(52,211,153,0.4)' },
  moveSpecial: { backgroundColor: tint(colors.gold, 0.15), borderColor: 'rgba(252,211,77,0.5)' },
  moveReady: { borderWidth: 2, borderColor: colors.gold },
  moveLocked: { opacity: 0.35 },
  moveName: { color: colors.text, fontSize: 15, fontWeight: '900' },
  moveDesc: { color: colors.muted, fontSize: 12, lineHeight: 16 },
  moveCost: { color: colors.gold, fontSize: 12, fontWeight: '800', marginTop: 2 },
  resultTitle: { fontSize: 32, fontWeight: '900', textAlign: 'center', marginTop: space.lg },
  caughtPanel: { alignItems: 'center' },
  caughtText: { fontSize: 20, fontWeight: '900' },
  statRow: { flexDirection: 'row' },
  celebrate: { fontSize: 18, fontWeight: '900', textAlign: 'center' },
  badgeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: tint(colors.gold, 0.15),
    borderWidth: 2,
    borderColor: 'rgba(252,211,77,0.5)',
    borderRadius: radius.lg,
    padding: space.md,
  },
  badgeIcon: { fontSize: 30 },
  badgeEyebrow: {
    color: colors.gold,
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  badgeName: { color: colors.text, fontSize: 16, fontWeight: '900' },
});
