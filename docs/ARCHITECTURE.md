# Royale — Architecture & Module Ownership

Portrait-first 3D poker. Vite + TypeScript + Three.js. No external asset
downloads: every texture, mesh and sound is generated procedurally at runtime,
which keeps the bundle tiny and the art direction perfectly consistent.

## Ground rules for every module

1. **Never import across subsystems directly.** Talk through `src/core/bus.ts`.
   The only shared imports are `src/core/*` (types, bus, stakes, rng, math).
2. **Own your files.** The ownership table below is exclusive. If you need a
   change in someone else's file, add it to your report instead of editing.
3. **Portrait only.** Design at 390×844 (iPhone 15). Must also survive 360×640
   and 430×932. Never assume landscape.
4. **Touch targets ≥ 44px.** Respect `--safe-t` / `--safe-b` on every fixed edge.
5. **Tokens only.** No raw hex, no magic durations in component CSS — pull from
   `src/ui/styles/tokens.css`. Add a token if one is genuinely missing.
6. **60fps floor on mid-tier phones.** No per-frame allocation, no layout
   thrash, no `filter:` on animating elements. Transform/opacity only.
7. **`npm run typecheck` must pass** when you finish. Strict mode is on.

## Runtime layering

```
┌──────────────────────────────────────────────────────┐
│  UI layer — DOM/CSS (crisp text, native scroll)      │  #ui-root
├──────────────────────────────────────────────────────┤
│  FX layer — DOM particles, toasts, confetti          │  #fx-root
├──────────────────────────────────────────────────────┤
│  Stage — Three.js WebGL (table, cards, chips, light) │  #stage
└──────────────────────────────────────────────────────┘
```

Text lives in DOM, never in WebGL — that is what keeps type razor-sharp on
retina phones. The 3D stage handles the felt, cards, chips, lighting, and
particle FX. The two layers stay in sync via projected screen anchors
published by the renderer (`renderer.anchors`).

## Module ownership

| Path | Owns | Never touches |
|---|---|---|
| `src/core/*` | types, bus, stakes, rng, math helpers | anything else |
| `src/engine/*` | rules, hand eval, betting, pots, SNG, bomb pots, bots | rendering, DOM |
| `src/render/*` | Three.js scene, camera, cards, chips, table, lighting, post | DOM UI, engine |
| `src/shaders/*` | GLSL only | — |
| `src/fx/*` | DOM particle/confetti/burst systems | engine |
| `src/audio/*` | Web Audio synthesis, music, mixer, haptics | rendering |
| `src/ui/*` | shell, router, all screens, components, CSS | engine internals |
| `src/social/*` | feed model, reactions, comments, seeded content | UI rendering of it |
| `src/econ/*` | wallet, store catalog, pass, cosmetics registry | UI rendering of it |
| `src/gto/*` | ranges, solver approximation, drills, scoring | UI rendering of it |
| `src/net/*` | client transport, reconnection, prediction | engine internals |
| `server/*` | authoritative multiplayer server | client code |
| `src/data/*` | seeded content: names, avatars, catalog JSON | — |

## Key contracts

- `src/core/types.ts` — all domain types. Append-only.
- `src/core/bus.ts` — all cross-module events. Add events here, typed.
- Renderer exposes `getAnchor(seat)` → `{x, y}` in CSS pixels so DOM HUD
  elements can pin to 3D seat positions.

## Performance tiers

`perf:tier` is emitted after a 90-frame probe. `low` disables post-processing
and halves particle counts; `high` enables bloom, contact shadows and the full
particle budget. Always read the tier before spawning heavy work.
