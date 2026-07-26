# The Design Bar

The standard this app is held to, and the rubric the design critic scores against.
A screen does not ship until it would win a blind side-by-side against the
reference apps below.

## Reference set (the competition)

These are the apps a reviewer would place ours next to. Each is here for a
specific reason — the critic should name *which* reference a screen loses to,
and on what dimension.

| App | What it does better than almost anything |
|---|---|
| **Balatro** | Tactile card feel, chunky readable type, every action has weight |
| **Clash Royale** | Reward moments, chest/unlock choreography, gold economy UI |
| **Marvel Snap** | Card art framing, rarity treatments, collection browsing |
| **Cash App** | Money typography, confident minimal density, brand nerve |
| **Revolut** | Financial data density that still breathes; premium tier upsell |
| **Things 3** | Restraint, typographic rhythm, motion that feels physical |
| **Apple Wallet** | Material depth, layered translucency, spring physics |
| **Duolingo** | Streaks, progress, celebration without being cheap |
| **Monument Valley** | Color grading and light as a mood, not decoration |
| **Alto's Odyssey** | Atmosphere; the sense that the scene is a *place* |

## Scoring rubric — 10 dimensions, 1–10 each

A screen must average **≥ 8.5** with **no dimension below 7** to pass.

1. **First-glance impact** — In 400ms, does it read as premium? Would a
   designer stop scrolling on it?
2. **Hierarchy** — Is there exactly one primary thing? Does the eye land where
   it should, then travel in the intended order? Or is everything the same
   weight (the #1 tell of generated UI)?
3. **Material & depth** — Real layered shadows, inner highlights, hairline
   strokes, translucency with saturation. Not flat rectangles, not uniform 1px
   grey borders.
4. **Typography** — Optical sizing, tight tracking on display type, tabular
   numerals on all money, no orphans, no cramped line-height, real weight
   contrast (not everything at 600).
5. **Color & light** — Restrained palette with one hero accent. Light appears
   to come from somewhere. No muddy greys, no unmotivated gradients, no
   default-purple.
6. **Density & rhythm** — Content-rich without clutter. Consistent spacing on
   the 4pt grid. Generous where it matters, tight where it should be.
7. **Motion** — Springs, not linears. Staggered entrances. Interruptible.
   Nothing janks. Nothing animates for no reason.
8. **Tactility & feedback** — Every touch produces a visible + audible +
   haptic response. Press states, not just hover states.
9. **Craft details** — The things nobody asks for: an empty state with an
   illustration, a loading skeleton that matches the real layout, a count-up
   on a number, a badge that animates in, correct safe-area insets.
10. **Cohesion** — Does it belong to the same app as the other screens? Same
    corner radii, same shadow language, same accent usage.

## Automatic failures

Any one of these fails the screen outright, regardless of score:

- Emoji used as an interface icon
- A flat purple/blue "AI gradient" as a primary surface
- Uniform card grid with no size or emphasis variation
- Text over an image or 3D scene with no scrim, at any contrast
- A touch target under 44px
- Content clipped by the notch or home indicator
- Placeholder copy ("Lorem", "Item 1", "Player1", "Coming soon")
- A number that reflows/jitters while animating (missing tabular-nums)
- Visible jank on entrance, or a 200ms+ blank frame on route change
- A scrollbar visible on a mobile surface
- Anything that requires landscape

## How the critic must report

For each screen: the ten scores, the single **worst** thing on the screen, the
three highest-leverage fixes in priority order, and a verdict on the blind
comparison — *"placed next to [reference app], a designer picks ___ because
___."* No praise without a specific reason. No "looks good overall".
