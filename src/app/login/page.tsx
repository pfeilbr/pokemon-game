'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useGame } from '@/components/GameProvider';
import { Button, Panel, Spinner } from '@/components/ui';
import { STRINGS } from '@/lib/i18n';

function LoginForm() {
  const router = useRouter();
  const { session, language, tr, refreshSession, cue } = useGame();
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (name.trim().length < 2) return setError(tr('nameTooShort'));
    if (!/^\d{4}$/.test(pin)) return setError(tr('pinFourDigits'));

    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/pin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), pin, mode }),
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(
          body.error === 'taken'
            ? tr('nameTaken')
            : body.error === 'mismatch'
              ? tr('wrongPin')
              : body.error === 'locked'
                ? language === 'zh'
                  ? '尝试次数过多，请15分钟后再试。'
                  : 'Too many tries. Wait 15 minutes and try again.'
                : tr('somethingWentWrong'),
        );
        return;
      }

      cue('levelUp');
      await refreshSession();
      router.push('/');
    } catch {
      setError(tr('somethingWentWrong'));
    } finally {
      setBusy(false);
    }
  };

  if (!session.accountsAvailable) {
    return (
      <Panel className="text-center">
        <p className="text-lg font-bold text-white">
          {language === 'zh' ? '此部署未启用账号功能。' : 'Accounts are not enabled on this deployment.'}
        </p>
        <p className="mt-2 text-sm text-slate-400">
          {language === 'zh'
            ? '游戏进度会保存在本设备上。'
            : 'Your progress is saved on this device instead.'}
        </p>
        <Link href="/" className="mt-4 inline-block font-bold text-amber-300 underline">
          {tr('goHome')}
        </Link>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-center text-slate-400">{tr('signInBlurb')}</p>

      {session.googleAvailable && (
        <>
          <a href="/api/auth/google" className="block">
            <Button variant="secondary" size="lg" full>
              <span aria-hidden>🔵</span> {tr('continueWithGoogle')}
            </Button>
          </a>
          <p className="text-center text-sm text-slate-500">{tr('orUsePin')}</p>
        </>
      )}

      <Panel className="flex flex-col gap-3">
        <label htmlFor="login-name" className="text-sm font-bold text-slate-300">
          {tr('chooseName')}
        </label>
        <input
          id="login-name"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          placeholder={tr('namePlaceholder')}
          autoComplete="username"
          className="rounded-2xl bg-slate-950/70 px-5 py-4 text-xl font-bold text-white ring-2 ring-white/15 outline-none placeholder:text-slate-600 focus:ring-amber-300"
        />

        <label htmlFor="login-pin" className="mt-1 text-sm font-bold text-slate-300">
          {tr('pin')}
        </label>
        <input
          id="login-pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          inputMode="numeric"
          autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
          placeholder="••••"
          className="rounded-2xl bg-slate-950/70 px-5 py-4 text-center font-mono text-3xl tracking-[0.5em] text-white ring-2 ring-white/15 outline-none placeholder:text-slate-700 focus:ring-amber-300"
        />
        <p className="text-xs text-slate-500">{tr('pinHint')}</p>

        {error && (
          <p className="font-semibold text-rose-400" role="alert">
            {error}
          </p>
        )}

        <Button onClick={submit} disabled={busy} size="lg" full data-testid="submit-login">
          {busy ? '…' : mode === 'register' ? tr('createAccount') : tr('signIn')}
        </Button>

        <button
          type="button"
          onClick={() => {
            setMode(mode === 'register' ? 'login' : 'register');
            setError(null);
          }}
          className="py-1 text-sm text-slate-400 underline"
        >
          {mode === 'register' ? tr('haveAccount') : tr('needAccount')}
        </button>
      </Panel>

      <Link href="/" className="text-center text-sm text-slate-500 underline">
        {tr('playWithoutAccount')}
      </Link>
    </div>
  );
}

export default function LoginPage() {
  const { language } = useGame();
  return (
    <main className="mx-auto flex min-h-[100dvh] w-full max-w-md flex-col justify-center gap-5 px-4 py-8">
      <div className="text-center">
        <h1 className="text-3xl font-black text-white">{STRINGS.appName[language]}</h1>
      </div>
      <Suspense fallback={<Spinner />}>
        <LoginForm />
      </Suspense>
    </main>
  );
}
