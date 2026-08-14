'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AppShell } from '@/components/AppShell';
import { CreatureArt } from '@/components/CreatureArt';
import { useGame } from '@/components/GameProvider';
import { ElementChip, Panel, Spinner, Stat, XpBar } from '@/components/ui';
import { getCreature } from '@/lib/game/creatures';
import { ELEMENT_STYLE } from '@/lib/game/elements';
import { badgeById, levelProgress, nextEvolutionLevel, partnerFor } from '@/lib/game/progress';
import { CREATURES } from '@/lib/game/creatures';

export default function HomePage() {
  const router = useRouter();
  const { profile, loading, language, tr } = useGame();

  useEffect(() => {
    if (!loading && !profile) router.replace('/start');
  }, [loading, profile, router]);

  if (loading || !profile) {
    return (
      <main className="flex min-h-[100dvh] items-center justify-center">
        <Spinner />
      </main>
    );
  }

  const partner = getCreature(partnerFor(profile));
  const style = ELEMENT_STYLE[partner.element];
  const progress = levelProgress(profile.xp);
  const evolvesAt = nextEvolutionLevel(profile);
  const caughtCount = new Set(profile.caught).size;

  const tiles = [
    {
      href: '/play',
      icon: '⚔️',
      title: tr('battle'),
      sub: tr('battleSub'),
      accent: 'from-rose-500/30',
    },
    {
      href: '/album',
      icon: '📗',
      title: tr('album'),
      sub: tr('albumSub'),
      accent: 'from-emerald-500/30',
    },
    {
      href: '/progress',
      icon: '🏆',
      title: tr('progress'),
      sub: tr('progressSub'),
      accent: 'from-amber-500/30',
    },
  ];

  return (
    <AppShell>
      <div className="flex flex-col gap-5">
        <section
          className="panel relative overflow-hidden p-5"
          style={{ background: `linear-gradient(150deg, ${style.color}26, rgba(19,28,51,0.92))` }}
        >
          <div className="flex items-center gap-4">
            <CreatureArt creature={partner} language={language} size={110} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-slate-300">
                {tr('hello')}, <span className="text-white">{profile.trainerName}</span>
              </p>
              <h1 className="truncate text-2xl font-black text-white sm:text-3xl">
                {partner.name[language]}
              </h1>
              <div className="mt-1.5 mb-3">
                <ElementChip element={partner.element} size="sm" label={style.label[language]} />
              </div>
              <XpBar
                into={progress.into}
                span={progress.span}
                level={progress.level}
                language={language}
              />
              <p className="mt-1.5 text-xs text-slate-300">
                {evolvesAt ? `${tr('evolvesAt')} ${evolvesAt}` : tr('finalForm')}
              </p>
            </div>
          </div>
        </section>

        <section className="grid grid-cols-3 gap-2.5">
          <Stat label={tr('mathLevel')} value={profile.tier} icon="🧮" />
          <Stat label={tr('caught')} value={`${caughtCount}/${CREATURES.length}`} icon="📗" />
          <Stat label={tr('streak')} value={profile.streak.current} icon="🔥" />
        </section>

        <nav className="grid gap-3 sm:grid-cols-3">
          {tiles.map((tile) => (
            <Link
              key={tile.href}
              href={tile.href}
              data-testid={`tile-${tile.href.slice(1)}`}
              className={`panel flex items-center gap-4 bg-gradient-to-br ${tile.accent} to-transparent p-5 transition-transform active:scale-[0.98] sm:flex-col sm:items-start`}
            >
              <span className="text-4xl" aria-hidden>
                {tile.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-xl font-black text-white">{tile.title}</span>
                <span className="block text-sm text-slate-400">{tile.sub}</span>
              </span>
            </Link>
          ))}
        </nav>

        {profile.badges.length > 0 && (
          <Panel>
            <h2 className="mb-3 text-sm font-bold tracking-wide text-slate-300 uppercase">
              {tr('badges')}
            </h2>
            <div className="flex flex-wrap gap-2">
              {profile.badges.map((id) => {
                const badge = badgeById(id);
                // Icon only; the full list with names lives on /progress.
                return (
                  <span
                    key={id}
                    className="rounded-xl bg-white/5 px-3 py-2 text-2xl"
                    title={badge?.name[language] ?? id}
                  >
                    {badge?.icon ?? '🏅'}
                  </span>
                );
              })}
            </div>
          </Panel>
        )}
      </div>
    </AppShell>
  );
}
