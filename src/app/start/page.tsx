'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CreatureArt } from '@/components/CreatureArt';
import { useGame } from '@/components/GameProvider';
import { Button, ElementChip, Panel } from '@/components/ui';
import { starters } from '@/lib/game/creatures';
import { ELEMENT_STYLE, strongAgainst } from '@/lib/game/elements';
import { createProfile } from '@/lib/game/progress';
import { STRINGS } from '@/lib/i18n';

/** Sign-up: pick a name, pick a partner, start playing. No account required. */
export default function StartPage() {
  const router = useRouter();
  const { profile, loading, setProfile, language, tr, cue } = useGame();
  const [step, setStep] = useState<'name' | 'partner'>('name');
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Already has a save - nothing to set up.
  useEffect(() => {
    if (!loading && profile) router.replace('/');
  }, [loading, profile, router]);

  const options = starters();

  const goToPartner = () => {
    if (name.trim().length < 2) {
      setError(tr('nameTooShort'));
      return;
    }
    setError(null);
    cue('tap');
    setStep('partner');
  };

  const begin = () => {
    if (!choice) return;
    cue('levelUp');
    setProfile(createProfile({ trainerName: name.trim(), starterId: choice, language }));
    router.push('/');
  };

  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-3xl flex-col justify-center gap-6 px-4 py-8">
      <div className="text-center">
        <h1 className="text-3xl font-black text-white sm:text-5xl">{STRINGS.appName[language]}</h1>
        <p className="mt-2 text-base text-slate-400 sm:text-lg">{STRINGS.tagline[language]}</p>
      </div>

      {step === 'name' ? (
        <Panel className="flex flex-col gap-4">
          <label htmlFor="trainer-name" className="text-xl font-bold text-white">
            {tr('chooseName')}
          </label>
          <input
            id="trainer-name"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 16))}
            onKeyDown={(e) => e.key === 'Enter' && goToPartner()}
            placeholder={tr('namePlaceholder')}
            autoComplete="nickname"
            autoFocus
            className="w-full rounded-2xl bg-slate-950/70 px-5 py-5 text-2xl font-bold text-white ring-2 ring-white/15 outline-none placeholder:text-slate-400 focus:ring-amber-300"
          />
          {error && <p className="font-semibold text-rose-400">{error}</p>}
          <Button onClick={goToPartner} size="lg" full>
            {tr('next')} →
          </Button>
        </Panel>
      ) : (
        <div className="flex flex-col gap-4">
          <h2 className="text-center text-2xl font-black text-white">{tr('choosePartner')}</h2>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {options.map((creature) => {
              const style = ELEMENT_STYLE[creature.element];
              const selected = choice === creature.id;
              return (
                <button
                  key={creature.id}
                  type="button"
                  onClick={() => {
                    setChoice(creature.id);
                    cue('tap');
                  }}
                  aria-pressed={selected}
                  data-testid={`starter-${creature.id}`}
                  className={`flex flex-col items-center gap-1 rounded-3xl p-3 transition-all ${
                    selected ? 'scale-[1.03] ring-4' : 'ring-1 ring-white/10 hover:ring-white/25'
                  }`}
                  style={{
                    background: `linear-gradient(160deg, ${style.color}26, rgba(19,28,51,0.9))`,
                    ...(selected ? { boxShadow: `0 0 0 4px ${style.color}` } : {}),
                  }}
                >
                  <CreatureArt
                    creature={creature}
                    language={language}
                    size={96}
                    animate={selected}
                  />
                  <span className="text-base font-extrabold text-white">
                    {creature.name[language]}
                  </span>
                  <ElementChip element={creature.element} size="sm" label={style.label[language]} />
                </button>
              );
            })}
          </div>

          {choice && (
            <Panel className="animate-pop text-center text-sm text-slate-300">
              <p className="mb-2 font-bold text-white">
                {options.find((c) => c.id === choice)!.flavor[language]}
              </p>
              <p>
                {tr('strongAgainst')}:{' '}
                {strongAgainst(options.find((c) => c.id === choice)!.element)
                  .map((e) => `${ELEMENT_STYLE[e].icon} ${ELEMENT_STYLE[e].label[language]}`)
                  .join('  ·  ')}
              </p>
            </Panel>
          )}

          <div className="flex gap-3">
            <Button variant="ghost" onClick={() => setStep('name')}>
              ← {tr('back')}
            </Button>
            <Button onClick={begin} disabled={!choice} size="lg" full data-testid="begin-adventure">
              {tr('startAdventure')}
            </Button>
          </div>
        </div>
      )}
    </main>
  );
}
