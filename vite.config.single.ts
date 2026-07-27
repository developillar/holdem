import { defineConfig } from 'vite';

/**
 * Single-file build. Collapses every dynamic import, chunk and stylesheet
 * into one entry so `tools/inline.mjs` can fold the whole app into a single
 * self-contained HTML document — no external requests, which is what a
 * strict-CSP host requires.
 */
export default defineConfig({
  build: {
    outDir: 'dist-single',
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8000,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
