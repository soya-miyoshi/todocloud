// Loads the viewer in a real browser and reports anything the browser says.
//
// This is the tier this repository does not otherwise have. `app.js` is
// 2,900 lines that only a browser executes: `tsc` checks it (see
// `packages/cli/assets/tsconfig.json`) and `node --test` never runs a line
// of it, which is how `const messageOf = (err) => (err instanceof Error ?
// messageOf(err) : String(err))` reached a phone and crashed it on load.
// `scripts/check-recursion.mjs` now catches that one shape; this catches the
// class — anything that throws while the page is loading, or on the way
// through its panes and dialogs.
//
// It needs a browser, which is a dependency this project does not carry, so
// it is opt-in and says so rather than failing:
//
//     npm i -D playwright && npx playwright install chromium
//     node scripts/probe-page.mjs                       # the local viewer
//     node scripts/probe-page.mjs packages/pwa/dist     # the built PWA
//     node scripts/probe-page.mjs --url https://…       # a deployed one
//
// The `/api` of the local run answers 503: there is no store here, and the
// page has to survive a provider that is not there — which is itself worth
// checking, since that is what an offline phone sees.

import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const args = process.argv.slice(2);
const urlAt = args.indexOf('--url');
const remote = urlAt >= 0 ? args[urlAt + 1] : undefined;
const root = args.find((a) => !a.startsWith('--') && a !== remote) ?? 'packages/cli/assets';

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  process.stdout.write(
    'probe-page: playwright is not installed, so there is no browser to load the page in.\n' +
      '  npm i -D playwright && npx playwright install chromium\n',
  );
  process.exit(0);
}

/** The media types the shell needs; a browser refuses the wrong one. */
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

/** serve puts a directory on a loopback port, with `/api` answering 503. */
async function serve(dir) {
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path.startsWith('/api/')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"code":"provider","message":"no store behind this probe"}}');
      return;
    }
    const file = join(dir, path === '/' ? 'index.html' : path.slice(1));
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end('not here');
      return;
    }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = /** @type {{port: number}} */ (server.address());
  return { url: `http://127.0.0.1:${port}/`, stop: () => server.close() };
}

const site = remote === undefined ? await serve(root) : { url: remote, stop: () => {} };

const browser = await chromium.launch();
// A phone, because that is the screen this viewer is drawn for.
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});

/** Everything the browser complained about, and what we were doing at the time. */
const bad = [];
let doing = 'loading';
page.on('pageerror', (err) => {
  const where = (err.stack ?? '').split('\n')[1]?.trim() ?? '';
  bad.push(`[${doing}] threw: ${err.message}${where ? `\n    ${where}` : ''}`);
});
page.on('console', (m) => {
  // A 503 from the fake `/api` is the point of the fake, not a finding.
  if (m.type() === 'error' && !m.text().includes('503')) {
    bad.push(`[${doing}] console.error: ${m.text()}`);
  }
});
page.on('crash', () => bad.push(`[${doing}] the page crashed`));

await page.goto(site.url, { waitUntil: 'load' });
await page.waitForTimeout(2000);

// Then through the furniture: every pane this page can show and every
// dialog it can open, because a handler bound at load is only run by a
// click. Each action is given a short deadline — a probe that waits thirty
// seconds for a control this shell does not have is a probe nobody runs —
// and a control that cannot be driven is a note rather than a finding: the
// two shells differ, and what this is looking for is what the browser
// throws, not what the script could not reach.
const notes = [];
const click = (sel) => page.click(sel, { timeout: 2500 });

const steps = [
  ['the settings dialog', async () => {
    await click('#prefs');
    await click('#prefs-close');
  }],
  ['the capture form', async () => {
    await click('#fab');
    await click('[data-new="task"]');
    await click('#capture-close');
  }],
  ['the perspective editor', async () => {
    await click('#new-perspective');
    await click('#perspective-close');
  }],
  ['Other Perspectives', async () => {
    await click('#show-other');
    await click('#show-other');
  }],
  // By address rather than by clicking a tile: with no store behind the
  // probe there is nothing in the lists and no tile to click, and these are
  // the addresses `parseHash` has to place anyway.
  ['every view, by address', async () => {
    for (const hash of ['#/', '#/inbox', '#/flagged', '#/next', '#/projects', '#/tags', '#/review', '#/all', '#/done', '#/home']) {
      await page.goto(`${site.url}${hash}`, { waitUntil: 'load' });
      await page.waitForTimeout(120);
    }
  }],
  ['the back button, twice', async () => {
    await page.goBack();
    await page.waitForTimeout(200);
    await page.goBack();
    await page.waitForTimeout(200);
  }],
  ['the search box', async () => {
    await page.goto(`${site.url}#/all`, { waitUntil: 'load' });
    await page.fill('#search-text', 'anything', { timeout: 2500 });
    await page.fill('#search-text', '', { timeout: 2500 });
  }],
  ['a reload, from Home', async () => {
    await page.goto(`${site.url}#/home`, { waitUntil: 'load' });
    await click('#reload');
  }],
];
for (const [what, run] of steps) {
  doing = what;
  try {
    await run();
    await page.waitForTimeout(250);
  } catch (err) {
    const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
    notes.push(`[${what}] not driven: ${why}`);
  }
}

await browser.close();
site.stop();

for (const note of notes) {
  process.stdout.write(`${note}\n`);
}
if (bad.length > 0) {
  process.stderr.write(`${bad.join('\n')}\n\n${bad.length} finding(s) in ${site.url}\n`);
  process.exit(1);
}
process.stdout.write(`${site.url}: loaded and driven with nothing thrown\n`);
