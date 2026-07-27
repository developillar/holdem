/**
 * Ambient declarations the UI layer needs. Kept inside `src/ui/components/`
 * because that directory is owned wholesale by the shell/component agent —
 * it is a declaration file, it emits nothing, and it is picked up by the
 * project-wide `tsc --noEmit` through `include: ["src"]`.
 *
 *  • `*.css` — lets a component co-locate its stylesheet with a side-effect
 *    import (`import '../styles/components.css'`), which is how Vite links
 *    CSS into the graph. Without this TS cannot resolve the specifier.
 *  • `import.meta.glob` — Vite's build-time directory glob. The shell uses it
 *    to register screens so that a screen module which does not exist yet
 *    degrades to a graceful placeholder instead of breaking the bundle.
 */

declare module '*.css' {
  const href: string;
  export default href;
}

interface ImportMeta {
  glob(
    pattern: string | string[],
    options?: { eager?: boolean; import?: string; query?: string },
  ): Record<string, () => Promise<unknown>>;
}
