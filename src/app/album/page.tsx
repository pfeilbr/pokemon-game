'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { CreatureArt } from '@/components/CreatureArt';
import { useGame } from '@/components/GameProvider';
import { ElementChip, Panel, Spinner } from '@/components/ui';
import { CREATURES, type Creature, creaturesByElement } from '@/lib/game/creatures';
import { ELEMENTS, ELEMENT_STYLE } from '@/lib/game/elements';
import { completion } from '@/lib/game/progress';

/** The collection album: one row per evolution line, locked slots silhouetted. */
export default function AlbumPage() {
  const router = useRouter();
  const { profile, loading, language, tr, cue } = useGame();
  const [selected, setSelected] = useState<Creature | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!loading && !profile) router.replace('/start');
  }, [loading, profile, router]);

  const close = useCallback(() => {
    setSelected(null);
    // Back to the card that opened it. Without this, closing drops focus on
    // <body> and a keyboard player restarts from the top of a 36-card album
    // every time they look at a creature.
    openerRef.current?.focus();
  }, []);

  // Escape closes it. Clicking the backdrop is a pointer affordance with no
  // keyboard equivalent at all, so without this the dialog is a room a
  // keyboard player can walk into and not out of.
  useEffect(() => {
    if (!selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, close]);

  // Focus follows the dialog in, so the next Tab is inside it rather than back
  // among the cards it is covering.
  useEffect(() => {
    if (selected) dialogRef.current?.focus();
  }, [selected]);

  /**
   * Keeps Tab inside the dialog while it is open.
   *
   * The cards behind it are still in the tab order - the overlay only covers
   * them visually - so without this, tabbing walks out of the dialog and into
   * controls the player cannot see.
   */
  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const stops = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (loading || !profile) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  const owned = new Set(profile.caught);
  const pct = Math.round(completion(profile) * 100);

  return (
    <AppShell>
      <div className="flex flex-col gap-4">
        <header className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-black text-white sm:text-3xl">{tr('albumTitle')}</h1>
          <span className="font-mono text-sm text-slate-400">
            {owned.size}/{CREATURES.length} · {pct}%
          </span>
        </header>

        <div className="h-3 w-full overflow-hidden rounded-full bg-slate-900 ring-1 ring-white/10">
          <div
            className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-sky-400 transition-[width] duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>

        {ELEMENTS.map((element) => {
          const style = ELEMENT_STYLE[element];
          const line = creaturesByElement(element);
          return (
            <section key={element}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-slate-300">
                <ElementChip element={element} size="sm" label={style.label[language]} />
              </h2>
              <div className="grid grid-cols-3 gap-2.5">
                {line.map((creature) => {
                  const has = owned.has(creature.id);
                  return (
                    <button
                      key={creature.id}
                      type="button"
                      data-testid={`album-${creature.id}`}
                      onClick={(event) => {
                        if (!has) return;
                        cue('tap');
                        openerRef.current = event.currentTarget;
                        setSelected(creature);
                      }}
                      aria-label={has ? creature.name[language] : tr('notCaughtYet')}
                      className="panel flex flex-col items-center gap-1 p-3 transition-transform active:scale-[0.97]"
                      style={
                        has
                          ? {
                              background: `linear-gradient(160deg, ${style.color}1f, rgba(19,28,51,0.9))`,
                            }
                          : undefined
                      }
                    >
                      <CreatureArt
                        creature={creature}
                        language={language}
                        size={72}
                        animate={false}
                        silhouette={!has}
                      />
                      <span
                        className={`text-center text-xs leading-tight font-bold ${has ? 'text-white' : 'text-slate-400'}`}
                      >
                        {has ? creature.name[language] : '???'}
                      </span>
                      <span className="text-[10px] text-slate-300">
                        {tr('stage')} {creature.stage}
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {selected && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center bg-black/70 p-4 sm:items-center"
          onClick={close}
          role="presentation"
        >
          <Panel
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="creature-dialog-title"
            tabIndex={-1}
            onKeyDown={trapTab}
            className="w-full max-w-sm animate-pop text-center"
            onClick={(e) => e.stopPropagation()}
          >
            <CreatureArt creature={selected} language={language} size={140} className="mx-auto" />
            <h3 id="creature-dialog-title" className="mt-2 text-2xl font-black text-white">
              {selected.name[language]}
            </h3>
            <div className="my-2 flex justify-center">
              <ElementChip
                element={selected.element}
                label={ELEMENT_STYLE[selected.element].label[language]}
              />
            </div>
            <p className="text-sm text-slate-300">{selected.flavor[language]}</p>
            <p className="mt-3 font-mono text-xs text-slate-400">
              {tr('health')} {selected.baseHp} · {tr('attack')} {selected.baseAtk} · {tr('stage')}{' '}
              {selected.stage}
            </p>
            <button
              type="button"
              data-testid="creature-dialog-close"
              onClick={close}
              className="tap mt-4 w-full rounded-xl bg-white/10 py-3 font-bold text-white"
            >
              {tr('back')}
            </button>
          </Panel>
        </div>
      )}
    </AppShell>
  );
}
