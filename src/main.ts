/**
 * Boot spine. Sequences: capability probe → renderer → audio → UI shell
 * → initial route. Every subsystem is lazy so first paint stays fast.
 */
import { bus } from './core/bus.ts';

const bootEl = document.getElementById('boot')!;
const barEl = bootEl.querySelector<HTMLElement>('.boot__bar i')!;
const labelEl = bootEl.querySelector<HTMLElement>('.boot__label')!;

function progress(pct: number, label?: string) {
  barEl.style.width = `${Math.max(6, Math.min(100, pct))}%`;
  if (label) labelEl.textContent = label;
}

async function boot() {
  try {
    progress(12, 'Shuffling up…');

    const { initRenderer } = await import('./render/renderer.ts');
    const { initAudio } = await import('./audio/audio.ts');
    const { mountShell } = await import('./ui/shell.ts');
    progress(34, 'Cutting the deck…');

    const canvas = document.getElementById('stage') as HTMLCanvasElement;
    const renderer = await initRenderer(canvas);
    progress(62, 'Racking chips…');

    await initAudio();
    progress(80, 'Taking a seat…');

    await mountShell(document.getElementById('ui-root')!);
    progress(96, 'Ready');

    renderer.start();

    // The 3D stage belongs to the table. Everywhere else it would show through
    // the screen's own background as a stray felt arc, so it cross-fades out
    // and stops drawing — which also hands the GPU back to the UI.
    let stageShown = false;
    const setStageVisible = (on: boolean) => {
      if (on === stageShown) return;
      stageShown = on;
      canvas.classList.toggle('is-hidden', !on);
      if (on) renderer.start();
      else setTimeout(() => !stageShown && renderer.stop(), 420);
    };
    setStageVisible(false);
    bus.on('nav:route', ({ route }) => setStageVisible(route === 'table'));

    await new Promise((r) => setTimeout(r, 220));
    progress(100);
    bootEl.classList.add('is-done');
    setTimeout(() => bootEl.remove(), 700);

    bus.emit('nav:route', { route: 'lobby' });
  } catch (err) {
    console.error('[boot] failed', err);
    labelEl.textContent = 'Something went wrong — pull to retry';
    labelEl.style.color = 'var(--c-bad)';
  }
}

// Lock to portrait where the platform allows it.
const so = screen.orientation as (ScreenOrientation & { lock?: (o: string) => Promise<void> }) | undefined;
so?.lock?.('portrait').catch(() => void 0);

// Kill iOS double-tap zoom + rubber-band without killing scrollable regions.
document.addEventListener(
  'touchmove',
  (e) => {
    if (!(e.target as HTMLElement)?.closest?.('.scroll')) e.preventDefault();
  },
  { passive: false },
);

boot();
