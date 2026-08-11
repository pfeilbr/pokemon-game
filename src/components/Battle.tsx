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
  type BattleState,
  availableMoves,
  battleReducer,
  beginCatch,
  createBattle,
  summarise,
} from '@/lib/game/battle';
import { MAX_CHARGE } from '@/lib/game/moves';
import { type BattleOutcome, applyBattleResult, levelFromXp } from '@/lib/game/progress';

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
  const [flash, setFlash] = useState<'player' | 'foe' | null>(null);
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

  // Sound and shake feedback for whatever just happened.
  useEffect(() => {
    if (!lastEntry) return;
    if (lastEntry.kind === 'playerHit') {
      cue(lastEntry.crit ? 'crit' : 'hit');
      setFlash('foe');
    } else if (lastEntry.kind === 'playerGlance') {
      cue('wrong');
      setFlash('foe');
    } else if (lastEntry.kind === 'foeHit') {
      setFlash('player');
    } else if (lastEntry.kind === 'caught') {
      cue('catch');
    }
    const timer = setTimeout(() => setFlash(null), 420);
    return () => clearTimeout(timer);
  }, [lastEntry, cue]);

  const submit = useCallback(() => {
    if (answer === '') return;
    const value = Number(answer);
    const correct = state.problem?.answer === value;
    cue(correct ? 'correct' : 'wrong');
    dispatch({ type: 'answer', value, now: Date.now() });
    setAnswer('');
  }, [answer, state.problem, cue]);

  const chooseMove = (moveId: string) => {
    cue('tap');
    setAnswer('');
    dispatch({ type: 'chooseMove', moveId, now: Date.now() });
  };

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
    <div className="flex flex-col gap-3" data-testid="battle">
      {/* Opponent */}
      <Panel
        className="relative overflow-hidden"
        style={{ background: `linear-gradient(160deg, ${foeStyle.color}1f, rgba(19,28,51,0.92))` }}
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="truncate font-extrabold text-white">{foe.name[language]}</span>
              <ElementChip element={foe.element} size="sm" label={foeStyle.label[language]} />
            </div>
            <HealthBar current={state.foe.hp} max={state.foe.maxHp} />
          </div>
          <div className={flash === 'foe' ? 'animate-shake' : ''}>
            <CreatureArt creature={foe} size={92} facing="left" animate={!flash} />
          </div>
        </div>
        <MatchupHint attacker={player.element} defender={foe.element} />
      </Panel>

      {/* Message / problem */}
      {solving && state.problem ? (
        <div
          className="panel flex flex-col items-center gap-1 py-5"
          style={{ background: isCatch ? 'rgba(52,211,153,0.12)' : undefined }}
        >
          <span className="text-xs font-bold tracking-widest text-slate-400 uppercase">
            {isCatch ? tr('catchPrompt') : tr('answer')}
          </span>
          <span
            className="text-center text-5xl leading-tight font-black text-white sm:text-6xl"
            data-testid="problem"
          >
            {state.problem.prompt}
          </span>
        </div>
      ) : (
        <BattleMessage state={state} />
      )}

      {/* Player */}
      <Panel
        style={{ background: `linear-gradient(160deg, ${playerStyle.color}1f, rgba(19,28,51,0.92))` }}
      >
        <div className="flex items-center gap-3">
          <div className={flash === 'player' ? 'animate-shake' : ''}>
            <CreatureArt creature={player} size={92} animate={!flash} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="truncate font-extrabold text-white">{player.name[language]}</span>
              <ElementChip element={player.element} size="sm" label={playerStyle.label[language]} />
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

      {/* Action area */}
      {state.phase === 'choosing' && (
        <div className="grid grid-cols-2 gap-2.5">
          {moves.map((move) => (
            <button
              key={move.id}
              type="button"
              disabled={!move.affordable}
              onClick={() => chooseMove(move.id)}
              data-testid={`move-${move.kind}`}
              className={`tap flex flex-col items-start gap-0.5 rounded-2xl p-3.5 text-left ring-1 transition-all active:scale-[0.97] disabled:opacity-35 ${
                move.kind === 'mend'
                  ? 'bg-emerald-500/15 ring-emerald-400/40'
                  : move.kind === 'special'
                    ? 'bg-amber-400/15 ring-amber-300/50'
                    : 'bg-white/5 ring-white/15'
              }`}
            >
              <span className="text-base leading-tight font-extrabold text-white">
                {move.name[language]}
              </span>
              <span className="text-xs leading-tight text-slate-400">{move.description[language]}</span>
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
        <Button variant="secondary" full onClick={() => dispatch({ type: 'continue' })}>
          {tr('continue')} →
        </Button>
      )}

      <button type="button" onClick={onExit} className="py-2 text-sm text-slate-500 underline">
        {tr('back')}
      </button>
    </div>
  );
}

function MatchupHint({ attacker, defender }: { attacker: Element; defender: Element }) {
  const { tr } = useGame();
  const multiplier = effectiveness(attacker, defender);
  if (multiplier === NEUTRAL) return null;

  const good = multiplier === SUPER_EFFECTIVE;
  return (
    <p className={`mt-2 text-center text-sm font-bold ${good ? 'text-emerald-400' : 'text-rose-400'}`}>
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
          <p className={`mt-2 text-xl font-black ${summary.caught ? 'text-emerald-400' : 'text-slate-400'}`}>
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
        <p className="animate-pop text-xl font-black text-sky-300">✨ {tr('evolvedInto')}!</p>
      )}
      {outcome && outcome.tierChanged > 0 && (
        <p className="animate-pop text-lg font-black text-emerald-300">🧠 {tr('mathLevelUp')}</p>
      )}
      {outcome?.newBadges.map((id) => (
        <p key={id} className="animate-pop text-lg font-black text-amber-300">
          🏅 {tr('newBadge')}
        </p>
      ))}

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
