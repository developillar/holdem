import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs so the build runs from any path — GitHub Pages serves
  // it out of /<repo>/, not the domain root.
  base: './',
  server: { host: true, port: 5173 },
  preview: { host: true, port: 4173 },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2400,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
        },
      },
    },
  },
});
