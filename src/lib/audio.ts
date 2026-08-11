/**
 * Sound effects, synthesised with the Web Audio API.
 *
 * No audio files: nothing to download, nothing to licence, and no delay before
 * the first sound plays. Every cue is a short shaped tone, which is plenty for
 * the feedback the game needs (right, wrong, hit, win) and keeps the whole
 * soundtrack under 100 lines.
 */

export type Cue =
  'tap' | 'correct' | 'wrong' | 'hit' | 'crit' | 'win' | 'lose' | 'catch' | 'levelUp';

type Note = { freq: number; at: number; duration: number; type?: OscillatorType; gain?: number };

const CUES: Record<Cue, Note[]> = {
  tap: [{ freq: 660, at: 0, duration: 0.05, gain: 0.12 }],
  correct: [
    { freq: 784, at: 0, duration: 0.09 },
    { freq: 1047, at: 0.08, duration: 0.13 },
  ],
  wrong: [
    { freq: 233, at: 0, duration: 0.14, type: 'triangle' },
    { freq: 175, at: 0.1, duration: 0.18, type: 'triangle' },
  ],
  hit: [{ freq: 140, at: 0, duration: 0.12, type: 'square', gain: 0.16 }],
  crit: [
    { freq: 180, at: 0, duration: 0.1, type: 'square', gain: 0.18 },
    { freq: 900, at: 0.05, duration: 0.14 },
  ],
  win: [
    { freq: 523, at: 0, duration: 0.11 },
    { freq: 659, at: 0.1, duration: 0.11 },
    { freq: 784, at: 0.2, duration: 0.11 },
    { freq: 1047, at: 0.3, duration: 0.26 },
  ],
  lose: [
    { freq: 392, at: 0, duration: 0.15, type: 'triangle' },
    { freq: 311, at: 0.14, duration: 0.15, type: 'triangle' },
    { freq: 233, at: 0.28, duration: 0.32, type: 'triangle' },
  ],
  catch: [
    { freq: 880, at: 0, duration: 0.08 },
    { freq: 1175, at: 0.09, duration: 0.08 },
    { freq: 1568, at: 0.18, duration: 0.22 },
  ],
  levelUp: [
    { freq: 659, at: 0, duration: 0.09 },
    { freq: 880, at: 0.09, duration: 0.09 },
    { freq: 1175, at: 0.18, duration: 0.24 },
  ],
};

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (context) return context;

  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;

  try {
    context = new Ctor();
    return context;
  } catch {
    // Some browsers refuse to construct one before a user gesture. Silence is
    // an acceptable outcome; a crash is not.
    return null;
  }
}

/**
 * Plays a cue. Safe to call anywhere: no-ops on the server, when the browser
 * has no Web Audio, or when the player has muted the game.
 */
export function play(cue: Cue, enabled = true): void {
  if (!enabled) return;
  const ctx = audioContext();
  if (!ctx) return;

  // Browsers suspend the context until a gesture; resume is a no-op otherwise.
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});

  const now = ctx.currentTime;
  for (const note of CUES[cue]) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const peak = note.gain ?? 0.14;

    osc.type = note.type ?? 'sine';
    osc.frequency.setValueAtTime(note.freq, now + note.at);

    // Short attack, exponential release - a plain on/off gate clicks audibly.
    gain.gain.setValueAtTime(0.0001, now + note.at);
    gain.gain.exponentialRampToValueAtTime(peak, now + note.at + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + note.duration);

    osc.connect(gain).connect(ctx.destination);
    osc.start(now + note.at);
    osc.stop(now + note.at + note.duration + 0.02);
  }
}
