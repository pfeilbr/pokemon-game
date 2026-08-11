'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { useGame } from '@/components/GameProvider';
import { Button, Panel, Spinner } from '@/components/ui';
import type { Language } from '@/lib/game/progress';

export default function SettingsPage() {
  const router = useRouter();
  const { profile, loading, session, language, tr, update, setProfile, signOut, cue } = useGame();
  const [confirmingReset, setConfirmingReset] = useState(false);

  if (loading) {
    return (
      <AppShell>
        <Spinner />
      </AppShell>
    );
  }

  if (!profile) {
    return (
      <AppShell>
        <Panel className="text-center">
          <Link href="/start" className="font-bold text-amber-300 underline">
            {tr('startAdventure')}
          </Link>
        </Panel>
      </AppShell>
    );
  }

  const setLanguage = (next: Language) => {
    cue('tap');
    update((p) => ({
      ...p,
      settings: { ...p.settings, language: next },
      updatedAt: new Date().toISOString(),
    }));
  };

  const toggleSound = () => {
    const next = !profile.settings.sound;
    // Play the confirmation before muting, so turning sound ON is audible.
    if (next) cue('correct');
    update((p) => ({
      ...p,
      settings: { ...p.settings, sound: next },
      updatedAt: new Date().toISOString(),
    }));
  };

  return (
    <AppShell>
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-black text-white sm:text-3xl">{tr('settings')}</h1>

        <Panel className="flex items-center justify-between gap-4">
          <span className="text-lg font-bold text-white">{tr('language')}</span>
          <div className="flex gap-2">
            {(['en', 'zh'] as const).map((lang) => (
              <button
                key={lang}
                type="button"
                onClick={() => setLanguage(lang)}
                data-testid={`lang-${lang}`}
                aria-pressed={language === lang}
                className={`tap rounded-xl px-5 py-3 font-extrabold ${
                  language === lang ? 'bg-amber-400 text-slate-900' : 'bg-white/5 text-slate-300'
                }`}
              >
                {lang === 'en' ? 'English' : '中文'}
              </button>
            ))}
          </div>
        </Panel>

        <Panel className="flex items-center justify-between gap-4">
          <span className="text-lg font-bold text-white">{tr('sound')}</span>
          <button
            type="button"
            onClick={toggleSound}
            data-testid="toggle-sound"
            aria-pressed={profile.settings.sound}
            className={`tap rounded-xl px-6 py-3 font-extrabold ${
              profile.settings.sound ? 'bg-emerald-400 text-slate-900' : 'bg-white/5 text-slate-300'
            }`}
          >
            {profile.settings.sound ? tr('on') : tr('off')}
          </button>
        </Panel>

        <Panel className="flex flex-col gap-3">
          <div>
            <p className="text-lg font-bold text-white">{profile.trainerName}</p>
            <p className="text-sm text-slate-400">
              {session.signedIn ? tr('savedToAccount') : tr('savedLocally')}
            </p>
          </div>

          {session.signedIn ? (
            <Button
              variant="ghost"
              onClick={async () => {
                await signOut();
                router.push('/');
              }}
            >
              {tr('signOut')}
            </Button>
          ) : (
            session.accountsAvailable && (
              <Link href="/login">
                <Button full>{tr('signInToSave')}</Button>
              </Link>
            )
          )}
        </Panel>

        <Panel className="flex flex-col gap-3">
          {confirmingReset ? (
            <>
              <p className="font-bold text-rose-300">
                {language === 'zh'
                  ? '确定要删除所有进度吗？此操作无法撤销。'
                  : 'Delete all progress? This cannot be undone.'}
              </p>
              <div className="flex gap-2">
                <Button variant="ghost" full onClick={() => setConfirmingReset(false)}>
                  {tr('back')}
                </Button>
                <Button
                  variant="danger"
                  full
                  onClick={() => {
                    setProfile(null);
                    router.push('/start');
                  }}
                >
                  {language === 'zh' ? '删除' : 'Delete'}
                </Button>
              </div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingReset(true)}
              className="py-2 text-sm text-slate-500 underline"
            >
              {language === 'zh' ? '重新开始' : 'Start over'}
            </button>
          )}
        </Panel>
      </div>
    </AppShell>
  );
}
