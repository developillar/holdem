/**
 * Visual QA harness. Boots a preview server, drives the app in a real
 * portrait-phone viewport, and captures screenshots for the design critic.
 *
 *   node tools/visual-qa.mjs                       # capture the default set
 *   node tools/visual-qa.mjs lobby table store     # capture specific routes
 *   node tools/visual-qa.mjs --out shots/round3    # choose output dir
 *
 * Screens are captured at 3x DPR to expose the blur, aliasing and hairline
 * defects that only show up on retina hardware.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const DEVICES = {
  iphone15: { width: 393, height: 852, dpr: 3, name: 'iPhone 15' },
  iphonese: { width: 375, height: 667, dpr: 2, name: 'iPhone SE' },
  pixel8: { width: 412, height: 915, dpr: 2.6, name: 'Pixel 8' },
};

/** route id → the actions needed to reach and settle that screen */
export const SCENES = {
  lobby: { route: 'lobby', settle: 900 },
  // The table opens behind a buy-in sheet. Confirm it, then let a hand run so
  // the capture shows real gameplay rather than a modal.
  table: {
    route: 'table',
    settle: 1200,
    after: async (page) => {
      const sit = page.getByText(/sit down/i).first();
      if (await sit.isVisible().catch(() => false)) {
        await sit.click({ timeout: 4000 }).catch(() => {});
      }
      await page.waitForTimeout(6500);
    },
  },
  feed: { route: 'feed', settle: 900 },
  store: { route: 'store', settle: 900 },
  pass: { route: 'pass', settle: 900 },
  trainer: { route: 'trainer', settle: 1400 },
  stats: { route: 'stats', settle: 1100 },
  profile: { route: 'profile', settle: 900 },
};

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outDir = path.resolve(ROOT, outIdx >= 0 ? args[outIdx + 1] : 'shots/latest');
const deviceIdx = args.indexOf('--device');
const device = DEVICES[deviceIdx >= 0 ? args[deviceIdx + 1] : 'iphone15'] ?? DEVICES.iphone15;
const wanted = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out' && args[i - 1] !== '--device');
const scenes = wanted.length ? wanted : Object.keys(SCENES);

async function waitForServer(url, timeoutMs = 90_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  if (!existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    console.log('[qa] no dist/ — building…');
    await new Promise((res, rej) => {
      const b = spawn('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
      b.on('exit', (c) => (c === 0 ? res() : rej(new Error(`build failed (${c})`))));
    });
  }

  const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--host'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stop = () => {
    try {
      server.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  };
  process.on('exit', stop);

  const up = await waitForServer('http://localhost:4173/');
  if (!up) {
    stop();
    throw new Error('preview server never came up');
  }

  // Prefer the full chromium build — the headless shell lacks the GPU paths
  // the 3D stage needs. Fall back to whatever Playwright resolves on its own.
  const CHROME_CANDIDATES = [
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/opt/pw-browsers/chromium/chrome-linux/chrome',
  ];
  const executablePath = CHROME_CANDIDATES.find((p) => existsSync(p));

  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage', '--no-sandbox'],
  });

  const ctx = await browser.newContext({
    viewport: { width: device.width, height: device.height },
    deviceScaleFactor: device.dpr,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });

  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  // Boot curtain must clear on its own — if it doesn't, that IS the bug.
  await page
    .waitForFunction(() => !document.getElementById('boot'), { timeout: 25_000 })
    .catch(() => errors.push('boot curtain never cleared'));

  const captured = [];
  for (const id of scenes) {
    const scene = SCENES[id];
    if (!scene) {
      console.warn(`[qa] unknown scene "${id}"`);
      continue;
    }
    await page.evaluate((route) => {
      // eslint-disable-next-line
      (window).__royale?.nav?.(route);
    }, scene.route);
    await page.waitForTimeout(scene.settle);
    if (scene.after) await scene.after(page);
    const file = path.join(outDir, `${id}.png`);
    await page.screenshot({ path: file });
    captured.push(file);
    console.log(`[qa] captured ${id} → ${path.relative(ROOT, file)}`);
  }

  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
          else resolve(Math.round((frames * 1000) / (performance.now() - t0)));
        };
        requestAnimationFrame(tick);
      }),
  );

  await writeFile(
    path.join(outDir, 'report.json'),
    JSON.stringify({ device: device.name, fps, errors, captured }, null, 2),
  );
  console.log(`[qa] fps≈${fps} (software GL) errors=${errors.length}`);
  if (errors.length) console.log('[qa] console errors:\n  ' + errors.slice(0, 20).join('\n  '));

  await browser.close();
  stop();
}

main().catch((e) => {
  console.error('[qa]', e);
  process.exit(1);
});
