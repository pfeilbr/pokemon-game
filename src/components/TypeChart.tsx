'use client';

import { ELEMENTS, ELEMENT_STYLE, type Element, strongAgainst, weakTo } from '@/lib/game/elements';
import type { Language } from '@/lib/game/progress';
import { STRINGS } from '@/lib/i18n';

/**
 * The full matchup table.
 *
 * Shown up front rather than hidden in a help screen: the wheel is the strategy
 * layer, and a chess-playing child should be able to plan a counter-pick rather
 * than discover the rules by losing.
 */
export function TypeChart({ language, highlight }: { language: Language; highlight?: Element }) {
  return (
    <div className="flex flex-col gap-2">
      {ELEMENTS.map((element) => {
        const style = ELEMENT_STYLE[element];
        const dim = highlight && highlight !== element;
        return (
          <div
            key={element}
            className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-3 py-2 transition-opacity ${
              dim ? 'opacity-40' : ''
            }`}
            style={{ background: `${style.color}14`, border: `1px solid ${style.color}33` }}
          >
            <span className="flex w-24 shrink-0 items-center gap-1.5 font-extrabold" style={{ color: style.color }}>
              <span aria-hidden>{style.icon}</span>
              {style.label[language]}
            </span>

            <span className="flex items-center gap-1 text-sm">
              <span className="text-emerald-400" aria-hidden>
                ▲
              </span>
              <span className="text-slate-400">{STRINGS.strongAgainst[language]}</span>
              {strongAgainst(element).map((e) => (
                <span key={e} title={ELEMENT_STYLE[e].label[language]} aria-hidden>
                  {ELEMENT_STYLE[e].icon}
                </span>
              ))}
            </span>

            <span className="flex items-center gap-1 text-sm">
              <span className="text-rose-400" aria-hidden>
                ▼
              </span>
              <span className="text-slate-400">{STRINGS.weakTo[language]}</span>
              {weakTo(element).map((e) => (
                <span key={e} title={ELEMENT_STYLE[e].label[language]} aria-hidden>
                  {ELEMENT_STYLE[e].icon}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
