/**
 * Generates the PWA icon set by rendering an SVG in Chromium and screenshotting
 * it at each required size. No design assets on disk, no image libraries — the
 * mark is drawn from the same gold gradient the app's boot curtain uses.
 *
 *   node tools/make-icons.mjs
 */
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'icons');

/** maskable icons need the mark inside the safe zone (80% of the canvas) */
function svg(size, { maskable = false, bg = true } = {}) {
  const pad = maskable ? size * 0.18 : size * 0.11;
  const inner = size - pad * 2;
  const r = maskable ? 0 : size * 0.22;
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0"    stop-color="#fdf3d0"/>
      <stop offset="0.24" stop-color="#edc96b"/>
      <stop offset="0.55" stop-color="#c08d21"/>
      <stop offset="0.78" stop-color="#edc96b"/>
      <stop offset="1"    stop-color="#f6e0a0"/>
    </linearGradient>
    <radialGradient id="bg" cx="0.5" cy="0.32" r="0.85">
      <stop offset="0"   stop-color="#182136"/>
      <stop offset="0.6" stop-color="#0b0e16"/>
      <stop offset="1"   stop-color="#05060a"/>
    </radialGradient>
  </defs>
  ${bg ? `<rect width="${size}" height="${size}" rx="${r}" fill="url(#bg)"/>` : ''}
  <g transform="translate(${pad} ${pad}) scale(${inner / 100})">
    <path d="M50 8 L78 34 Q94 50 78 66 Q64 80 50 66 Q36 80 22 66 Q6 50 22 34 Z" fill="url(#g)"/>
    <path d="M45 63 h10 l5 26 h-20 z" fill="url(#g)"/>
  </g>
</svg>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, opts: {} },
  { file: 'icon-512.png', size: 512, opts: {} },
  { file: 'maskable-192.png', size: 192, opts: { maskable: true } },
  { file: 'maskable-512.png', size: 512, opts: { maskable: true } },
  // iOS home-screen icon: no transparency, no rounding (iOS masks it itself)
  { file: 'apple-touch-icon.png', size: 180, opts: {} },
  { file: 'favicon-32.png', size: 32, opts: {} },
];

const CHROME = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium/chrome-linux/chrome',
].find((p) => existsSync(p));

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

for (const t of TARGETS) {
  const ctx = await browser.newContext({
    viewport: { width: t.size, height: t.size },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  await page.setContent(
    `<!doctype html><html><body style="margin:0">${svg(t.size, t.opts)}</body></html>`,
    { waitUntil: 'load' },
  );
  await page.screenshot({ path: path.join(OUT, t.file), omitBackground: false });
  console.log(`[icons] ${t.file} (${t.size}px)`);
  await ctx.close();
}

await browser.close();
