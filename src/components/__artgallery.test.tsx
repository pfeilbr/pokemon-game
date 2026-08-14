/**
 * Not a test so much as a visual harness: renders every creature to a static
 * HTML gallery so the art can be eyeballed in a browser. Kept out of the way
 * behind an env flag; `ART_GALLERY=1 npx vitest run` writes the file.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { writeFileSync } from 'node:fs';
import { CREATURES } from '@/lib/game/creatures';
import { ELEMENT_STYLE } from '@/lib/game/elements';
import { CreatureArt } from './CreatureArt';

describe('creature art', () => {
  it('renders every creature without throwing', () => {
    for (const creature of CREATURES) {
      const markup = renderToStaticMarkup(<CreatureArt creature={creature} language="en" />);
      expect(markup).toContain('<svg');
      expect(markup).toContain(creature.name.en);
    }
  });

  it.runIf(process.env.ART_GALLERY)('writes a gallery for visual review', () => {
    const cards = CREATURES.map((c) => {
      const style = ELEMENT_STYLE[c.element];
      return `<figure style="background:linear-gradient(160deg, ${style.color}22, #131c33); border:1px solid ${style.color}55">
        ${renderToStaticMarkup(<CreatureArt creature={c} language="en" size={140} animate={false} />)}
        <figcaption><b>${c.name.en}</b> <span>${c.name.zh}</span><br/><small>${style.icon} ${style.label.en} · stage ${c.stage}</small></figcaption>
      </figure>`;
    }).join('');

    writeFileSync(
      process.env.ART_GALLERY!,
      `<!doctype html><meta charset="utf-8"><body style="margin:0;padding:24px;background:#0b1120;color:#e2e8f0;font-family:system-ui">
       <h1>Mathmon roster</h1>
       <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:14px">${cards}</div>
       <style>figure{margin:0;padding:14px;border-radius:18px;text-align:center}
       figcaption{margin-top:8px;font-size:13px;line-height:1.5}
       small{opacity:.7}</style></body>`,
    );
  });
});
