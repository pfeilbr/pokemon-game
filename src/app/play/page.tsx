'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Battle } from '@/components/Battle';
import { CreatureArt } from '@/components/CreatureArt';
import { useGame } from '@/components/GameProvider';
import { TypeChart } from '@/components/TypeChart';
import { Button, ElementChip, Panel, Spinner } from '@/components/ui';
import { availableAtLevel, getCreature } from '@/lib/game/creatures';
import { ELEMENT_STYLE, NEUTRAL, SUPER_EFFECTIVE, effectiveness } from '@/lib/game/elements';
import { levelFromXp, partnerFor } from '@/lib/game/progress';
import { createRng } from '@/lib/game/rng';

/** How many opponents to offer. Enough to choose between, few enough to scan. */
const OPPONENT_COUNT = 3;

export default function PlayPage() {
  const router = useRouter();
  const { profile, loading, language, tr, cue } = useGame();
  const [opponentId, setOpponentId] = useState<string | null>(null);
  const [battleKey, setBattleKey] = useState(0);
  const [showChart, setShowChart] = useState(false);

  useEffect(() => {
    if (!loading && !profile) router.replace('/start');
  }, [loading, profile, router]);

  if (loading || !profile) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  const partner = getCreature(partnerFor(profile));
  const level = levelFromXp(profile.xp);

  if (opponentId) {
    return (
      <AppShell>
        <Battle
          key={`${opponentId}-${battleKey}`}
          playerCreatureId={partner.id}
          opponentId={opponentId}
          // Back to opponent selection, so the next fight is a fresh choice.
          onExit={() => setOpponentId(null)}
          onRematch={() => setBattleKey((k) => k + 1)}
        />
      </AppShell>
    );
  }

  // Deterministic per battle so a refresh does not reroll the choices, but it
  // changes as the player levels and after each fight.
  const rng = createRng(
    `${profile.trainerName}:${profile.battlesWon + profile.battlesLost}:${level}`,
  );
  const pool = availableAtLevel(level).filter((c) => c.id !== partner.id);
  const opponents = rng.shuffle(pool).slice(0, OPPONENT_COUNT);

  return (
    <AppShell>
      <div className="flex flex-col gap-4">
        <header className="text-center">
          <h1 className="text-2xl font-black text-white sm:text-3xl">{tr('pickOpponent')}</h1>
          <p className="mt-1 text-sm text-slate-400">{tr('pickOpponentSub')}</p>
        </header>

        <Panel className="flex items-center justify-center gap-3">
          <span className="text-sm font-bold text-slate-400">{tr('yourType')}</span>
          <CreatureArt creature={partner} language={language} size={52} animate={false} />
          <span className="font-extrabold text-white">{partner.name[language]}</span>
          <ElementChip
            element={partner.element}
            size="sm"
            label={ELEMENT_STYLE[partner.element].label[language]}
          />
        </Panel>

        <div className="grid gap-3 sm:grid-cols-3">
          {opponents.map((foe) => {
            const style = ELEMENT_STYLE[foe.element];
            const attacking = effectiveness(partner.element, foe.element);
            const defending = effectiveness(foe.element, partner.element);

            // Net advantage, so the label reflects the whole exchange rather
            // than only the player's own damage.
            const verdict =
              attacking > defending
                ? { text: tr('goodMatchup'), tone: 'text-emerald-400', icon: '▲' }
                : attacking < defending
                  ? { text: tr('badMatchup'), tone: 'text-rose-400', icon: '▼' }
                  : { text: tr('evenMatchup'), tone: 'text-slate-400', icon: '=' };

            return (
              <button
                key={foe.id}
                type="button"
                data-testid={`opponent-${foe.id}`}
                onClick={() => {
                  cue('tap');
                  setOpponentId(foe.id);
                }}
                className="panel flex flex-col items-center gap-2 p-4 transition-transform active:scale-[0.97]"
                style={{
                  background: `linear-gradient(160deg, ${style.color}22, rgba(19,28,51,0.9))`,
                }}
              >
                <CreatureArt creature={foe} language={language} size={104} animate={false} />
                <span className="text-lg font-extrabold text-white">{foe.name[language]}</span>
                <ElementChip element={foe.element} size="sm" label={style.label[language]} />
                <span className={`text-sm font-bold ${verdict.tone}`}>
                  <span aria-hidden>{verdict.icon} </span>
                  {verdict.text}
                </span>
                <span className="text-xs text-slate-500">
                  {attacking === SUPER_EFFECTIVE && `⚔️ ×2  `}
                  {attacking < NEUTRAL && `⚔️ ×0.5  `}
                  {defending === SUPER_EFFECTIVE && `🛡️ ×2`}
                  {defending < NEUTRAL && `🛡️ ×0.5`}
                </span>
              </button>
            );
          })}
        </div>

        <Panel>
          <button
            type="button"
            onClick={() => setShowChart((v) => !v)}
            className="tap flex w-full items-center justify-between text-left"
            aria-expanded={showChart}
          >
            <span className="text-lg font-bold text-white">🔄 {tr('typeChart')}</span>
            <span className="text-2xl text-slate-400" aria-hidden>
              {showChart ? '−' : '+'}
            </span>
          </button>
          {showChart && (
            <div className="mt-3">
              <TypeChart language={language} />
            </div>
          )}
        </Panel>

        <Button variant="ghost" onClick={() => router.push('/')}>
          ← {tr('goHome')}
        </Button>
      </div>
    </AppShell>
  );
}
