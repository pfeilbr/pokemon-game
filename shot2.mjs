import { chromium } from 'playwright';
const b = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
const p = await b.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2 });
await p.goto('file://' + process.argv[2]);
await p.waitForTimeout(500);
await p.screenshot({ path: process.argv[3], fullPage: true });
await b.close();
