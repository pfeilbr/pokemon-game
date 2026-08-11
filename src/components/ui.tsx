'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { ELEMENT_STYLE, type Element } from '@/lib/game/elements';

/** Shared primitives. Every tappable thing is at least 56px tall. */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'md' | 'lg';
  full?: boolean;
};

const VARIANTS: Record<NonNullable<ButtonProps['variant']>, string> = {
  primary:
    'bg-gradient-to-b from-amber-300 to-amber-500 text-slate-900 shadow-[0_6px_0_0_#b45309] active:translate-y-[3px] active:shadow-[0_3px_0_0_#b45309]',
  secondary:
    'bg-gradient-to-b from-slate-600 to-slate-700 text-white shadow-[0_6px_0_0_#1e293b] active:translate-y-[3px] active:shadow-[0_3px_0_0_#1e293b]',
  ghost: 'bg-white/5 text-slate-200 border border-white/15 hover:bg-white/10',
  danger:
    'bg-gradient-to-b from-rose-400 to-rose-600 text-white shadow-[0_6px_0_0_#9f1239] active:translate-y-[3px] active:shadow-[0_3px_0_0_#9f1239]',
};

export function Button({
  variant = 'primary',
  size = 'md',
  full = false,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      className={[
        'tap inline-flex items-center justify-center gap-2 rounded-2xl font-extrabold transition-all',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none disabled:active:translate-y-0',
        size === 'lg' ? 'px-8 py-5 text-2xl' : 'px-5 py-3.5 text-lg',
        full ? 'w-full' : '',
        VARIANTS[variant],
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </button>
  );
}

export function Panel({
  children,
  className = '',
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} className={`panel p-4 sm:p-5 ${className}`}>
      {children}
    </div>
  );
}

export function ElementChip({
  element,
  size = 'md',
  label,
}: {
  element: Element;
  size?: 'sm' | 'md';
  label?: string;
}) {
  const style = ELEMENT_STYLE[element];
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full font-bold whitespace-nowrap',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-sm',
      ].join(' ')}
      style={{
        background: `${style.color}22`,
        color: style.color,
        border: `1px solid ${style.color}66`,
      }}
    >
      <span aria-hidden>{style.icon}</span>
      {label ?? style.label.en}
    </span>
  );
}

export function HealthBar({
  current,
  max,
  label,
  compact = false,
}: {
  current: number;
  max: number;
  label?: string;
  compact?: boolean;
}) {
  const ratio = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  // Green above half, amber down to a fifth, red below - readable at a glance
  // without needing to read the numbers.
  const colour = ratio > 0.5 ? '#34d399' : ratio > 0.2 ? '#fbbf24' : '#fb7185';

  return (
    <div className="w-full">
      {label && (
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-bold text-slate-200">{label}</span>
          <span className="shrink-0 font-mono text-xs text-slate-400" aria-hidden>
            {Math.ceil(current)}/{max}
          </span>
        </div>
      )}
      <div
        className={`w-full overflow-hidden rounded-full bg-slate-900/80 ring-1 ring-white/10 ${compact ? 'h-2.5' : 'h-4'}`}
        role="progressbar"
        aria-valuenow={Math.ceil(current)}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={label ?? 'Health'}
      >
        <div
          className="h-full rounded-full transition-[width] duration-500 ease-out"
          style={{
            width: `${ratio * 100}%`,
            background: `linear-gradient(90deg, ${colour}, ${colour}cc)`,
          }}
        />
      </div>
    </div>
  );
}

export function XpBar({ into, span, level }: { into: number; span: number; level: number }) {
  const ratio = span > 0 ? Math.max(0, Math.min(1, into / span)) : 1;
  return (
    <div className="w-full">
      <div className="mb-1 flex items-baseline justify-between text-xs font-bold text-slate-300">
        <span>Lv {level}</span>
        <span className="font-mono text-slate-400">{span > 0 ? `${into}/${span}` : 'MAX'}</span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-900/80 ring-1 ring-white/10">
        <div
          className="h-full rounded-full bg-gradient-to-r from-sky-400 to-indigo-400 transition-[width] duration-700"
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

export function ChargeMeter({
  charge,
  max,
  label,
}: {
  charge: number;
  max: number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs font-bold tracking-wide text-slate-300 uppercase">{label}</span>
      <div className="flex gap-1.5">
        {Array.from({ length: max }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className={[
              'block h-4 w-4 rounded-full ring-1 transition-all duration-300',
              i < charge
                ? 'bg-amber-300 shadow-[0_0_10px_2px_rgba(252,211,77,0.65)] ring-amber-200'
                : 'bg-slate-800 ring-white/15',
            ].join(' ')}
          />
        ))}
      </div>
      <span className="sr-only">
        {charge} of {max}
      </span>
    </div>
  );
}

export function Stat({ label, value, icon }: { label: string; value: ReactNode; icon?: string }) {
  return (
    <div className="panel flex flex-col items-center justify-center gap-0.5 px-3 py-3 text-center">
      {icon && (
        <span className="text-xl" aria-hidden>
          {icon}
        </span>
      )}
      <span className="text-xl leading-none font-extrabold text-white sm:text-2xl">{value}</span>
      <span className="text-[11px] leading-tight font-semibold text-slate-400 uppercase">
        {label}
      </span>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-slate-400">
      <span className="h-9 w-9 animate-spin rounded-full border-4 border-slate-700 border-t-amber-300" />
      {label && <span className="text-sm font-semibold">{label}</span>}
    </div>
  );
}
