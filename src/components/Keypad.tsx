'use client';

import { useEffect } from 'react';

/**
 * The answer keypad.
 *
 * A numeric keypad rather than a text input, for two reasons: on a tablet it
 * avoids the OS keyboard covering half the battle, and it keeps answers to
 * digits, which is why the maths generator only ever produces non-negative
 * whole numbers. A physical keyboard still works for anyone using one.
 */

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitLabel: string;
  clearLabel: string;
  onKeyPress?: () => void;
};

const MAX_DIGITS = 4;

export function Keypad({
  value,
  onChange,
  onSubmit,
  disabled = false,
  submitLabel,
  clearLabel,
  onKeyPress,
}: Props) {
  const pressDigit = (digit: string) => {
    if (disabled || value.length >= MAX_DIGITS) return;
    // Stop leading zeros piling up ("007"), which look like a bug to a child.
    onChange(value === '0' ? digit : value + digit);
    onKeyPress?.();
  };

  const backspace = () => {
    if (disabled) return;
    onChange(value.slice(0, -1));
    onKeyPress?.();
  };

  const submit = () => {
    if (disabled || value.length === 0) return;
    onSubmit();
  };

  // Hardware keyboard support, so a laptop player is not forced to click.
  useEffect(() => {
    if (disabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key >= '0' && event.key <= '9') {
        event.preventDefault();
        pressDigit(event.key);
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        backspace();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        submit();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        onChange('');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  const keyClass =
    'tap flex items-center justify-center rounded-2xl bg-slate-800/90 text-3xl font-extrabold text-white ' +
    'ring-1 ring-white/10 transition-all active:scale-95 active:bg-slate-700 disabled:opacity-40 ' +
    'hover:bg-slate-700/90 h-14 sm:h-[4.5rem]';

  return (
    <div className="w-full">
      <div
        className="mb-2 flex h-16 w-full sm:mb-3 sm:h-20 items-center justify-center rounded-2xl bg-slate-950/70 px-4 ring-2 ring-white/15"
        aria-live="polite"
      >
        <span
          className={`font-mono text-5xl font-black tabular-nums ${value ? 'text-amber-300' : 'text-slate-700'}`}
          data-testid="answer-display"
        >
          {value || '?'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
          <button
            key={digit}
            type="button"
            className={keyClass}
            disabled={disabled}
            onClick={() => pressDigit(digit)}
            aria-label={digit}
          >
            {digit}
          </button>
        ))}

        <button
          type="button"
          className={`${keyClass} text-lg`}
          disabled={disabled}
          onClick={() => {
            onChange('');
            onKeyPress?.();
          }}
          aria-label={clearLabel}
        >
          {clearLabel}
        </button>

        <button
          type="button"
          className={keyClass}
          disabled={disabled}
          onClick={() => pressDigit('0')}
          aria-label="0"
        >
          0
        </button>

        <button
          type="button"
          className={`${keyClass} text-3xl`}
          disabled={disabled}
          onClick={backspace}
          aria-label="Backspace"
        >
          ⌫
        </button>
      </div>

      <button
        type="button"
        onClick={submit}
        disabled={disabled || value.length === 0}
        data-testid="submit-answer"
        className="tap mt-3 w-full rounded-2xl bg-gradient-to-b from-emerald-400 to-emerald-600 px-6 py-4 text-3xl font-black sm:py-5 text-white shadow-[0_6px_0_0_#065f46] transition-all active:translate-y-[3px] active:shadow-[0_3px_0_0_#065f46] disabled:opacity-40 disabled:shadow-none"
      >
        {submitLabel}
      </button>
    </div>
  );
}
