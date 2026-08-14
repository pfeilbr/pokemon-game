'use client';

import { useEffect, useSyncExternalStore } from 'react';

/**
 * Whether this device has a pointer that can rest on things - the closest the
 * platform gets to "there is probably a keyboard attached".
 *
 * Module scope, not inline: `useSyncExternalStore` compares snapshots by
 * identity, so a fresh closure per render would loop forever.
 */
const POINTER_QUERY = '(hover: hover) and (pointer: fine)';

function subscribeToPointer(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const media = window.matchMedia(POINTER_QUERY);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

function hasFinePointer(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia(POINTER_QUERY).matches;
}

/**
 * The answer keypad.
 *
 * A numeric keypad rather than a text input, for two reasons: on a tablet it
 * avoids the OS keyboard covering half the battle, and it keeps answers to
 * digits, which is why the maths generator only ever produces non-negative
 * whole numbers.
 *
 * The same app runs on a laptop, though, and the difficulty adapter is
 * calibrated around how slow this control is: par at tier 1 is 5.1 seconds
 * because hunting for digits with a pointer takes a seven-year-old about
 * seven. So physical keys drive the keypad too - `press` below is the only
 * thing that can change the answer, and a tap and a keystroke both go through
 * it. Two code paths would drift, and what drifts silently is the digit cap
 * and the leading-zero rule: nothing errors, the answer is just wrong in one
 * of the two places.
 */

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  submitLabel: string;
  clearLabel: string;
  /** The ⌫ key draws a glyph, so its accessible name is the only text it has. */
  backspaceLabel: string;
  /** Shown only on a device that actually has a physical keyboard. */
  keyboardHint: string;
  onKeyPress?: () => void;
};

const MAX_DIGITS = 4;

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

/** Every key on the pad, however it came to be pressed. */
type Key = (typeof DIGITS)[number] | 'backspace' | 'clear' | 'submit';

/**
 * Whether the keystroke belongs to whatever already has focus.
 *
 * The listener below is on `window`, which makes it a keystroke thief unless
 * it declines the keys it does not own. Two owners matter:
 *
 *  - A text field owns everything typed into it. No text field shares the
 *    battle screen today, but the trainer-name and PIN fields exist elsewhere
 *    in the app, and a global digit handler that swallowed them would read as
 *    a broken keyboard rather than as a bug.
 *  - A focused control owns Enter, because Enter is how it gets pressed.
 *    Without this a player who tabs to the "7" key and presses Enter submits
 *    an empty answer instead of typing a 7, which makes the keypad unusable
 *    by keyboard alone - the exact opposite of the point.
 */
function belongsToFocus(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;

  const activates = tag === 'BUTTON' || tag === 'A' || target.getAttribute('role') === 'button';
  return key === 'Enter' && activates;
}

/** The physical key as a key on the pad, or null for "not ours". */
function keyFor(event: KeyboardEvent): Key | null {
  // A shortcut is never an answer: Ctrl+R still reloads and ⌘Q still quits.
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (belongsToFocus(event.target, event.key)) return null;

  const digit = DIGITS.find((d) => d === event.key);
  if (digit) return digit;
  if (event.key === 'Backspace') return 'backspace';
  if (event.key === 'Enter') return 'submit';
  if (event.key === 'Escape') return 'clear';
  return null;
}

export function Keypad({
  value,
  onChange,
  onSubmit,
  disabled = false,
  submitLabel,
  clearLabel,
  backspaceLabel,
  keyboardHint,
  onKeyPress,
}: Props) {
  /** The one place a pressed key becomes an answer. */
  const press = (key: Key) => {
    if (disabled) return;

    if (key === 'submit') {
      if (value.length === 0) return;
      onSubmit();
      return;
    }

    if (key === 'clear') {
      onChange('');
    } else if (key === 'backspace') {
      onChange(value.slice(0, -1));
    } else {
      if (value.length >= MAX_DIGITS) return;
      // Stop leading zeros piling up ("007"), which look like a bug to a child.
      onChange(value === '0' ? key : value + key);
    }

    onKeyPress?.();
  };

  // Hardware keyboard support, so a laptop player is not forced to click.
  // No dependency array on purpose: the handler closes over `value`, and a
  // stale closure would mean the second typed digit replacing the first.
  useEffect(() => {
    if (disabled) return;
    const handler = (event: KeyboardEvent) => {
      const key = keyFor(event);
      if (key === null) return;
      event.preventDefault();
      press(key);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  });

  // Claimed only where it is true. A phone has no keyboard to point at, and
  // this screen belongs to a seven-year-old, so an unusable tip is clutter.
  //
  // `useSyncExternalStore` rather than setState-in-an-effect: the server
  // snapshot is `false`, so the server and the first client render agree and
  // there is no hydration mismatch, without the cascading render an effect
  // that sets state on mount causes. It also keeps the tip honest if the
  // answer changes under us - an iPad in a keyboard case is exactly this
  // child's device, and detaching it should retract the tip.
  const hasKeyboard = useSyncExternalStore(subscribeToPointer, hasFinePointer, () => false);

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
          className={`font-mono text-5xl font-black tabular-nums ${value ? 'text-amber-300' : 'text-slate-500'}`}
          data-testid="answer-display"
        >
          {value || '?'}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-2.5">
        {(['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const).map((digit) => (
          <button
            key={digit}
            type="button"
            className={keyClass}
            disabled={disabled}
            onClick={() => press(digit)}
            aria-label={digit}
          >
            {digit}
          </button>
        ))}

        <button
          type="button"
          className={`${keyClass} text-lg`}
          disabled={disabled}
          onClick={() => press('clear')}
          aria-label={clearLabel}
        >
          {clearLabel}
        </button>

        <button
          type="button"
          className={keyClass}
          disabled={disabled}
          onClick={() => press('0')}
          aria-label="0"
        >
          0
        </button>

        <button
          type="button"
          className={`${keyClass} text-3xl`}
          disabled={disabled}
          onClick={() => press('backspace')}
          aria-label={backspaceLabel}
        >
          ⌫
        </button>
      </div>

      <button
        type="button"
        onClick={() => press('submit')}
        disabled={disabled || value.length === 0}
        data-testid="submit-answer"
        className="tap mt-3 w-full rounded-2xl bg-gradient-to-b from-emerald-400 to-emerald-600 px-6 py-4 text-3xl font-black sm:py-5 text-slate-900 shadow-[0_6px_0_0_#065f46] transition-all active:translate-y-[3px] active:shadow-[0_3px_0_0_#065f46] disabled:opacity-40 disabled:shadow-none"
      >
        {submitLabel}
      </button>

      {hasKeyboard && (
        <p className="mt-2 text-center text-xs text-slate-400" data-testid="keyboard-hint">
          <span aria-hidden>⌨ </span>
          {keyboardHint}
        </p>
      )}
    </div>
  );
}
