/**
 * Folds the single-file build into one HTML document with zero external
 * requests, then strips the outer document tags so it can be embedded by a
 * host that supplies its own <head>.
 *
 *   node tools/inline.mjs [outFile]
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist-single');
const OUT = path.resolve(ROOT, process.argv[2] ?? 'dist-single/royale.html');

const html = await readFile(path.join(DIST, 'index.html'), 'utf8');
const assets = await readdir(path.join(DIST, 'assets'));

const jsFile = assets.find((f) => f.endsWith('.js'));
const cssFile = assets.find((f) => f.endsWith('.css'));
if (!jsFile) throw new Error('no js bundle found — did the build run?');

const js = await readFile(path.join(DIST, 'assets', jsFile), 'utf8');
const css = cssFile ? await readFile(path.join(DIST, 'assets', cssFile), 'utf8') : '';

// Pull the body markup out of the built document; the host wraps us in its own
// <!doctype>/<head>/<body>, so shipping our own would nest documents.
const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
let body = bodyMatch ? bodyMatch[1] : html;

// Drop the built asset references — their contents are inlined below instead.
body = body
  .replace(/<script[^>]*\ssrc=["'][^"']*["'][^>]*><\/script>/gi, '')
  .replace(/<link[^>]*rel=["'](?:stylesheet|modulepreload)["'][^>]*>/gi, '');

// </script> inside a string literal would close the tag early.
const safeJs = js.replace(/<\/script>/gi, '<\\/script>');

const out = `<title>Royale — Poker</title>
<style>
${css}
/* The host page supplies the document chrome; pin our shell to the viewport. */
html, body { margin: 0; padding: 0; height: 100%; background: #05060a; }
</style>
${body.trim()}
<script type="module">
${safeJs}
</script>
`;

await writeFile(OUT, out, 'utf8');
const kb = (Buffer.byteLength(out) / 1024).toFixed(0);
console.log(`[inline] wrote ${path.relative(ROOT, OUT)} (${kb} KB, single file, no external requests)`);
