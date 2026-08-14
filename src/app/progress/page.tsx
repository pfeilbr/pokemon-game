'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { AppShell } from '@/components/AppShell';
import { useGame } from '@/components/GameProvider';
import { Panel, Spinner, Stat } from '@/components/ui';
import { SKILLS, SKILL_META, accuracyOf, averageSeconds } from '@/lib/game/math';
import { BADGES, levelFromXp, overallAccuracy } from '@/lib/game/progress';

/**
 * Progress and stats.
 *
 * Doubles as the parent-facing view: the maths breakdown shows accuracy and
 * average time per skill, which is the bit a parent actually wants to know.
 */
export default function ProgressPage() {
  const router = useRouter();
  const { profile, loading, language, tr } = useGame();

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

  const earned = new Set(profile.badges);
  const practised = SKILLS.filter((skill) => (profile.skillStats[skill]?.attempts ?? 0) > 0);

  return (
    <AppShell>
      <div className="flex flex-col gap-5">
        <h1 className="text-2xl font-black text-white sm:text-3xl">{tr('progressTitle')}</h1>

        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <Stat label={tr('level')} value={levelFromXp(profile.xp)} icon="⭐" />
          <Stat label={tr('battlesWon')} value={profile.battlesWon} icon="⚔️" />
          <Stat
            label={tr('accuracy')}
            value={`${Math.round(overallAccuracy(profile) * 100)}%`}
            icon="🎯"
          />
          <Stat label={tr('streak')} value={profile.streak.current} icon="🔥" />
        </div>

        <Panel>
          <h2 className="mb-3 text-lg font-bold text-white">
            {tr('badges')}{' '}
            <span className="font-mono text-sm text-slate-400">
              {earned.size}/{BADGES.length}
            </span>
          </h2>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
            {BADGES.map((badge) => {
              const has = earned.has(badge.id);
              return (
                <div
                  key={badge.id}
                  data-testid={`badge-${badge.id}`}
                  className={`flex items-center gap-3 rounded-2xl p-3 ring-1 ${
                    has ? 'bg-amber-400/10 ring-amber-300/40' : 'bg-white/[0.03] ring-white/10'
                  }`}
                >
                  <span className={`text-3xl ${has ? '' : 'opacity-25 grayscale'}`} aria-hidden>
                    {badge.icon}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={`block text-sm leading-tight font-extrabold ${has ? 'text-white' : 'text-slate-400'}`}
                    >
                      {has ? badge.name[language] : tr('locked')}
                    </span>
                    <span className="block text-xs leading-tight text-slate-400">
                      {badge.description[language]}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        </Panel>

        <Panel>
          <h2 className="mb-1 text-lg font-bold text-white">{tr('mathsBreakdown')}</h2>
          <p className="mb-3 text-xs text-slate-400">
            {tr('questionsAnswered')}: {profile.problemsTotal}
          </p>

          {practised.length === 0 ? (
            <p className="py-6 text-center text-slate-400">{tr('noDataYet')}</p>
          ) : (
            <div className="flex flex-col gap-2.5">
              {practised.map((skill) => {
                const stat = profile.skillStats[skill]!;
                const accuracy = accuracyOf(stat);
                const pct = Math.round(accuracy * 100);
                const colour =
                  accuracy >= 0.8 ? '#34d399' : accuracy >= 0.5 ? '#fbbf24' : '#fb7185';
                return (
                  <div key={skill} data-testid={`skill-${skill}`}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-bold text-slate-200">
                        {SKILL_META[skill].label[language]}
                      </span>
                      <span className="font-mono text-xs text-slate-400" title={tr('avgTime')}>
                        {pct}% · {averageSeconds(stat).toFixed(1)}
                        {tr('seconds')} · {stat.attempts}
                      </span>
                    </div>
                    <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-900 ring-1 ring-white/10">
                      <div
                        className="h-full rounded-full transition-[width] duration-700"
                        style={{ width: `${pct}%`, background: colour }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
