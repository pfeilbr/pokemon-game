'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CreatureArt } from './CreatureArt';
import { useGame } from './GameProvider';
import { Keypad } from './Keypad';
import { Button, ChargeMeter, ElementChip, HealthBar, Panel } from './ui';
import { getCreature } from '@/lib/game/creatures';
import {
  ELEMENT_STYLE,
  NEUTRAL,
  SUPER_EFFECTIVE,
  type Element,
  effectiveness,
} from '@/lib/game/elements';
import {
  CRIT_THRESHOLD,
  MAX_SPEED_BONUS,
  type BattleState,
  availableMoves,
  battleReducer,
  createBattle,
  speedFraction,
  summarise,
} from '@/lib/game/battle';
import { MAX_CHARGE } from '@/lib/game/moves';
import {
  type BattleOutcome,
  applyBattleResult,
  badgeById,
  levelFromXp,
  partnerFor,
} from '@/lib/game/progress';

/**
 * The battle screen.
 *
 * Owns the timing and presentation; every rule lives in the battle reducer.
 * The reducer is fed the clock explicitly, which is why the whole fight is
 * testable without faking timers.
 */

type Props = {
  playerCreatureId: string;
  opponentId: string;
  onExit: () => void;
  onRematch: () => void;
};

/** How long the hit animation and damage numbers stay up. */
const RESOLVE_MS = 1500;

export function Battle({ playerCreatureId, opponentId, onExit, onRematch }: Props) {
  const router = useRouter();
  const { profile, update, language, tr, cue } = useGame();

  const level = profile ? levelFromXp(profile.xp) : 1;

  const [state, dispatch] = useReducer(
    battleReducer,
    { playerCreatureId, opponentId, level, tier: profile?.tier ?? 1 },
    (init) =>
      createBattle({
        // Seeded from the battle count so each fight differs but a refresh
        // mid-battle does not reshuffle the questions.
        seed: `${profile?.trainerName ?? 'guest'}:${(profile?.battlesWon ?? 0) + (profile?.battlesLost ?? 0)}:${init.opponentId}`,
        playerCreatureId: init.playerCreatureId,
        foeCreatureId: init.opponentId,
        playerLevel: init.level,
        foeLevel: init.level,
        tier: init.tier,
      }),
  );

  const [answer, setAnswer] = useState('');
  const [outcome, setOutcome] = useState<BattleOutcome | null>(null);
  const recorded = useRef(false);

  const player = getCreature(state.player.creatureId);
  const foe = getCreature(state.foe.creatureId);
  const moves = availableMoves(state);

  const lastEntry = state.log.at(-1);

  // ---- Phase side effects ------------------------------------------------

  // Start the catch clock only once its screen is actually on show, so the
  // speed of the catch answer is measured from when the player could see it.
  useEffect(() => {
    if (state.phase === 'catching' && state.problemShownAt === null) {
      dispatch({ type: 'beginCatch', now: Date.now() });
    }
  }, [state.phase, state.problemShownAt]);

  // Auto-advance out of the resolve animation.
  useEffect(() => {
    if (state.phase !== 'resolving') return;
    const timer = setTimeout(() => dispatch({ type: 'continue' }), RESOLVE_MS);
    return () => clearTimeout(timer);
  }, [state.phase, state.turn]);

  // Fold the finished battle into the profile exactly once.
  useEffect(() => {
    if (state.phase !== 'victory' && state.phase !== 'defeat') return;
    if (recorded.current || !profile) return;
    recorded.current = true;

    const summary = summarise(state);
    const result = applyBattleResult(profile, summary, state.attempts);
    setOutcome(result);
    update(() => result.profile);
    cue(summary.won ? 'win' : 'lose');
  }, [state, profile, update, cue]);

  // Sound for whatever just happened. The shake is derived below rather than
  // held in state, so this effect only talks to the audio system.
  useEffect(() => {
    if (!lastEntry) return;
    if (lastEntry.kind === 'playerHit') cue(lastEntry.crit ? 'crit' : 'hit');
    else if (lastEntry.kind === 'playerGlance') cue('wrong');
    else if (lastEntry.kind === 'caught') cue('catch');
  }, [lastEntry, cue]);

  /** Which fighter just took a hit, derived straight from the battle log. */
  const struck =
    lastEntry?.kind === 'playerHit' || lastEntry?.kind === 'playerGlance'
      ? 'foe'
      : lastEntry?.kind === 'foeHit'
        ? 'player'
        : null;

  const submit = useCallback(() => {
    if (answer === '') return;
    const value = Number(answer);
    const correct = state.problem?.answer === value;
    cue(correct ? 'correct' : 'wrong');
    dispatch({ type: 'answer', value, now: Date.now() });
    setAnswer('');
  }, [answer, state.problem, cue]);

  const chooseMove = useCallback(
    (moveId: string) => {
      cue('tap');
      setAnswer('');
      dispatch({ type: 'chooseMove', moveId, now: Date.now() });
    },
    [cue],
  );

  // ---- Rendering ---------------------------------------------------------

  const foeStyle = ELEMENT_STYLE[foe.element];
  const playerStyle = ELEMENT_STYLE[player.element];

  if (state.phase === 'victory' || state.phase === 'defeat') {
    return (
      <VictoryScreen
        state={state}
        outcome={outcome}
        onExit={onExit}
        onRematch={() => {
          recorded.current = false;
          onRematch();
        }}
        onHome={() => router.push('/')}
      />
    );
  }

  const solving = state.phase === 'solving' || state.phase === 'catching';
  const isCatch = state.phase === 'catching';

  return (
    // Two columns once there is room, so a whole battle fits on screen without
    // scrolling on a laptop. Stacked on a phone, where scrolling is natural.
    <div
      className="grid items-start gap-2 sm:gap-3 lg:grid-cols-[minmax(0,1fr)_22rem]"
      data-testid="battle"
    >
      <div className="flex flex-col gap-2 sm:gap-3">
        {/* Opponent */}
        <Panel
          className="relative overflow-hidden"
          style={{
            background: `linear-gradient(160deg, ${foeStyle.color}1f, rgba(19,28,51,0.92))`,
          }}
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <span className="truncate font-extrabold text-white">{foe.name[language]}</span>
                <ElementChip element={foe.element} size="sm" label={foeStyle.label[language]} />
              </div>
              <HealthBar current={state.foe.hp} max={state.foe.maxHp} />
            </div>
            <div key={state.log.length} className={struck === 'foe' ? 'animate-shake' : ''}>
              <CreatureArt
                creature={foe}
                size={96}
                facing="left"
                animate
                className="h-[68px] w-[68px] sm:h-24 sm:w-24"
              />
            </div>
          </div>
          <MatchupHint attacker={player.element} defender={foe.element} />
        </Panel>

        {/* Message / problem */}
        {solving && state.problem ? (
          <div
            className="panel flex flex-col items-center gap-0.5 py-3 sm:py-5"
            style={{
              background: isCatch ? 'rgba(52,211,153,0.12)' : undefined,
            }}
          >
            <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
              {isCatch ? tr('catchPrompt') : tr('answer')}
            </span>
            <span
              className="text-center text-4xl leading-tight font-black text-white sm:text-6xl"
              data-testid="problem"
            >
              {state.problem.prompt}
            </span>
            {state.problemShownAt !== null && (
              <div className="mt-2 w-full max-w-xs">
                <SpeedMeter
                  key={state.problemShownAt}
                  startedAt={state.problemShownAt}
                  parSeconds={state.problem.parTime}
                />
              </div>
            )}
          </div>
        ) : (
          <BattleMessage state={state} />
        )}

        {/* Player */}
        <Panel
          style={{
            background: `linear-gradient(160deg, ${playerStyle.color}1f, rgba(19,28,51,0.92))`,
          }}
        >
          <div className="flex items-center gap-3">
            <div key={state.log.length} className={struck === 'player' ? 'animate-shake' : ''}>
              <CreatureArt
                creature={player}
                size={96}
                animate
                className="h-[68px] w-[68px] sm:h-24 sm:w-24"
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1 flex items-center gap-2">
                <span className="truncate font-extrabold text-white">{player.name[language]}</span>
                <ElementChip
                  element={player.element}
                  size="sm"
                  label={playerStyle.label[language]}
                />
              </div>
              <HealthBar current={state.player.hp} max={state.player.maxHp} />
              <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                <ChargeMeter charge={state.charge} max={MAX_CHARGE} label={tr('charge')} />
                {state.combo > 1 && (
                  <span className="animate-pop rounded-full bg-amber-400/20 px-3 py-1 text-sm font-black text-amber-300">
                    {tr('combo')} ×{state.combo}
                  </span>
                )}
              </div>
            </div>
          </div>
        </Panel>
      </div>

      {/* Action area */}
      <div className="flex flex-col gap-2 sm:gap-3">
        {state.phase === 'choosing' && (
          <div className="grid grid-cols-2 gap-2.5">
            {moves.map((move) => (
              <button
                key={move.id}
                type="button"
                disabled={!move.affordable}
                onClick={() => chooseMove(move.id)}
                data-testid={`move-${move.kind}`}
                className={[
                  'tap flex flex-col items-start gap-0.5 rounded-2xl p-3.5 text-left ring-1',
                  'transition-all active:scale-[0.97] disabled:opacity-35',
                  move.kind === 'mend'
                    ? 'bg-emerald-500/15 ring-emerald-400/40'
                    : move.kind === 'special'
                      ? 'bg-amber-400/15 ring-amber-300/50'
                      : 'bg-white/5 ring-white/15',
                  // The special is the answer to a bad matchup, so make it
                  // impossible to miss the moment it is actually usable.
                  move.chargeCost > 0 && move.affordable
                    ? 'animate-pop ring-2 shadow-[0_0_18px_-2px_rgba(252,211,77,0.7)]'
                    : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <span className="text-base leading-tight font-extrabold text-white">
                  {move.name[language]}
                </span>
                <span className="text-xs leading-tight text-slate-400">
                  {move.description[language]}
                </span>
                {move.chargeCost > 0 && (
                  <span className="mt-1 text-xs font-bold text-amber-300">
                    ⚡ {move.chargeCost}/{MAX_CHARGE}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}

        {solving && (
          <Keypad
            value={answer}
            onChange={setAnswer}
            onSubmit={submit}
            submitLabel={isCatch ? tr('catchIt') : tr('submit')}
            clearLabel={tr('clear')}
            onKeyPress={() => cue('tap')}
          />
        )}

        {state.phase === 'resolving' && (
          <Button
            variant="secondary"
            full
            data-testid="continue-turn"
            onClick={() => dispatch({ type: 'continue' })}
          >
            {tr('continue')} →
          </Button>
        )}

        <button type="button" onClick={onExit} className="py-2 text-sm text-slate-500 underline">
          {tr('back')}
        </button>
      </div>
    </div>
  );
}

/**
 * The speed meter.
 *
 * The engine already pays up to +30% damage for a fast answer and flags a
 * critical hit above a threshold, but none of that was visible - so a child saw
 * "Critical hit!" some turns and "Correct!" others with no idea why. This shows
 * the reward draining away in real time.
 *
 * Deliberately pure upside: when it empties nothing bad happens, the hit is
 * simply normal, and the meter says so. Speed earns a bonus; slowness is never
 * punished.
 *
 * Driven by an interval rather than a CSS transition on purpose. Reduced-motion
 * users have transitions globally collapsed to ~0ms, which would snap this bar
 * straight to empty and misinform them.
 */
function SpeedMeter({ startedAt, parSeconds }: { startedAt: number; parSeconds: number }) {
  const { tr } = useGame();
  const [fraction, setFraction] = useState(1);

  // No reset needed here: the call site keys this component by `startedAt`, so
  // each new question mounts a fresh meter already full.
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
    <div className="w-full px-1" data-testid="speed-meter">
      <div className="mb-1 flex items-baseline justify-between text-xs font-bold">
        {bonusPercent > 0 ? (
          <>
            <span className={crit ? 'text-amber-300' : 'text-slate-300'}>
              {crit ? '⚡ ' : ''}
              {tr('speedBonus')}
            </span>
            <span className="font-mono text-slate-300">+{bonusPercent}%</span>
          </>
        ) : (
          // No penalty here, and the wording makes that explicit.
          <span className="text-slate-500">{tr('takeYourTime')}</span>
        )}
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-900/80 ring-1 ring-white/10">
        <div
          className="h-full rounded-full"
          style={{
            width: `${fraction * 100}%`,
            background: crit
              ? 'linear-gradient(90deg,#fbbf24,#fde68a)'
              : 'linear-gradient(90deg,#38bdf8,#7dd3fc)',
          }}
        />
      </div>
    </div>
  );
}

function MatchupHint({ attacker, defender }: { attacker: Element; defender: Element }) {
  const { tr } = useGame();
  const multiplier = effectiveness(attacker, defender);
  if (multiplier === NEUTRAL) return null;

  const good = multiplier === SUPER_EFFECTIVE;
  return (
    <p
      className={`mt-2 text-center text-sm font-bold ${good ? 'text-emerald-400' : 'text-rose-400'}`}
    >
      {good ? `✨ ${tr('superEffective')}` : `🛡️ ${tr('notVeryEffective')}`}
    </p>
  );
}

function BattleMessage({ state }: { state: BattleState }) {
  const { tr } = useGame();
  const entry = state.log.at(-1);

  if (!entry) {
    return (
      <div className="panel py-5 text-center">
        <p className="text-lg font-bold text-white">{tr('wildAppeared')}</p>
        <p className="text-sm text-slate-400">{tr('chooseMove')}</p>
      </div>
    );
  }

  if (entry.kind === 'playerGlance') {
    return (
      <div className="panel animate-pop py-5 text-center">
        <p className="text-lg font-black text-rose-400">{tr('wrong')}</p>
        <p className="text-sm text-slate-300">
          {tr('theAnswerWas')} <b className="text-white">{entry.correctAnswer}</b>
        </p>
      </div>
    );
  }

  if (entry.kind === 'playerHit') {
    return (
      <div className="panel animate-pop py-5 text-center">
        <p className="text-lg font-black text-emerald-400">
          {entry.crit ? `⚡ ${tr('critical')}` : tr('correct')}
        </p>
        <p className="text-3xl font-black text-white">−{entry.amount}</p>
      </div>
    );
  }

  if (entry.kind === 'playerMend') {
    return (
      <div className="panel animate-pop py-5 text-center">
        <p className="text-3xl font-black text-emerald-400">+{entry.amount}</p>
      </div>
    );
  }

  if (entry.kind === 'foeHit') {
    return (
      <div className="panel animate-pop py-5 text-center">
        <p className="text-3xl font-black text-rose-400">−{entry.amount}</p>
      </div>
    );
  }

  return (
    <div className="panel py-5 text-center">
      <p className="text-sm text-slate-400">{tr('chooseMove')}</p>
    </div>
  );
}

function VictoryScreen({
  state,
  outcome,
  onExit,
  onRematch,
  onHome,
}: {
  state: BattleState;
  outcome: BattleOutcome | null;
  onExit: () => void;
  onRematch: () => void;
  onHome: () => void;
}) {
  const { language, tr } = useGame();
  const summary = useMemo(() => summarise(state), [state]);
  const foe = getCreature(state.foe.creatureId);
  const won = summary.won;

  return (
    <div className="flex flex-col items-center gap-4 py-4 text-center" data-testid="battle-result">
      <h1 className={`text-4xl font-black ${won ? 'text-amber-300' : 'text-slate-300'}`}>
        {won ? `🎉 ${tr('youWin')}` : tr('youLost')}
      </h1>

      {won && (
        <Panel className="w-full max-w-sm">
          <CreatureArt creature={foe} size={120} className="mx-auto" />
          <p
            className={`mt-2 text-xl font-black ${summary.caught ? 'text-emerald-400' : 'text-slate-400'}`}
          >
            {summary.caught ? `✨ ${tr('gotIt')}` : tr('itEscaped')}
          </p>
          <p className="text-sm text-slate-400">{foe.name[language]}</p>
        </Panel>
      )}

      <Panel className="grid w-full max-w-sm grid-cols-3 gap-3">
        <div>
          <p className="text-2xl font-black text-white">+{outcome?.xpGained ?? 0}</p>
          <p className="text-xs text-slate-400 uppercase">{tr('xpEarned')}</p>
        </div>
        <div>
          <p className="text-2xl font-black text-white">
            {summary.total > 0 ? Math.round((summary.correct / summary.total) * 100) : 0}%
          </p>
          <p className="text-xs text-slate-400 uppercase">{tr('accuracy')}</p>
        </div>
        <div>
          <p className="text-2xl font-black text-white">×{summary.bestCombo}</p>
          <p className="text-xs text-slate-400 uppercase">{tr('bestCombo')}</p>
        </div>
      </Panel>

      {outcome?.leveledUp && (
        <p className="animate-pop text-xl font-black text-amber-300">
          🌟 {tr('levelUp')} → {outcome.newLevel}
        </p>
      )}
      {outcome?.evolved && (
        <p className="animate-pop text-xl font-black text-sky-300">
          ✨ {getCreature(partnerFor(outcome.profile)).name[language]} — {tr('evolvedInto')}!
        </p>
      )}
      {outcome && outcome.tierChanged > 0 && (
        <p className="animate-pop text-lg font-black text-emerald-300">🧠 {tr('mathLevelUp')}</p>
      )}

      {/* Name the badges rather than just announcing that some arrived. */}
      {outcome && outcome.newBadges.length > 0 && (
        <div className="flex w-full max-w-sm flex-col gap-2">
          {outcome.newBadges.map((id) => {
            const badge = badgeById(id);
            if (!badge) return null;
            return (
              <div
                key={id}
                data-testid={`new-badge-${id}`}
                className="animate-pop flex items-center gap-3 rounded-2xl bg-amber-400/15 p-3 text-left ring-2 ring-amber-300/50"
              >
                <span className="text-3xl" aria-hidden>
                  {badge.icon}
                </span>
                <span>
                  <span className="block text-xs font-bold text-amber-300 uppercase">
                    {tr('newBadge')}
                  </span>
                  <span className="block font-extrabold text-white">{badge.name[language]}</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex w-full max-w-sm flex-col gap-2">
        <Button size="lg" full onClick={onRematch} data-testid="play-again">
          {tr('playAgain')}
        </Button>
        <Button variant="secondary" full onClick={onExit}>
          {tr('pickOpponent')}
        </Button>
        <Button variant="ghost" full onClick={onHome}>
          {tr('goHome')}
        </Button>
      </div>
    </div>
  );
}
