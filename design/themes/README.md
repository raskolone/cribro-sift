# Nocturne Green — Theme Handoff

A dark, calm, "quiet neon" theme extracted from a working product mockup.
Product-agnostic: nothing here names a product, a domain, or a feature.
Use it as the single visual foundation across all your apps.

## Files

| File | What it is |
| --- | --- |
| `tokens.css` | The source of truth. CSS custom properties + base resets. Link or import it once, globally. |
| `tailwind.config.snippet.js` | The same tokens mapped into a Tailwind theme, if the app uses Tailwind. |
| `components.md` | The recipes: buttons, cards, inputs, badges, tables, nav, modal — with exact values. |
| `constellation.js` | The animated background (drifting dots + proximity lines, no cursor interaction). Framework-free. |
| `CLAUDE-CODE-PROMPT.md` | Paste this into Claude Code as the opening instruction. |

## The idea in one paragraph

Near-black blue ground with a single soft radial lift at the top. One accent —
mint green `#72f0b4` — used as a line, a glow and small type, never as a large flood.
Surfaces are translucent glass on top of that ground, separated by 1px hairline borders
at 7% white, not by shadow alone. Three typefaces with strict roles: a serif for headings,
a geometric sans for UI text, a mono for labels and numbers. Everything animates on
0.2s ease; nothing bounces.

## Rules that keep it coherent

1. **One accent.** `--accent` is the only saturated color. Warning amber and error red exist for state, not for decoration.
2. **Accent never fills a large area.** Buttons at full `--accent` are the single exception — and only for the one primary action on screen.
3. **Glow is functional.** A glow marks the active, selected, or primary thing. If everything glows, nothing does.
4. **Borders before shadows.** Every surface has a 1px hairline. Shadows are ambient depth, not edges.
5. **Type roles are fixed.** Serif = headings only. Mono = uppercase labels, counters, metadata, code. Sans = everything else.
6. **Transitions are 0.2s ease.** Hover = 1–2px lift + accent-tinted border. No scale-up on hover.
7. **No pure black, no pure white.** `#05070d` is the deepest ink, `#fff` only for large display headings.

## Install

```html
<link rel="stylesheet" href="tokens.css">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=DM+Sans:wght@400;500;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<link href="https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css" rel="stylesheet">
```

Icons are Phosphor throughout (`<i class="ph ph-sparkle"></i>`), regular weight for
interface, fill weight only for state indicators like check marks.

## Background

```html
<canvas id="constellation"></canvas>
<script src="constellation.js"></script>
```

The canvas is `position:fixed; inset:0; z-index:0; pointer-events:none`. All app
content sits in a wrapper at `position:relative; z-index:1`. The page gradient lives
on `body`, not on the wrapper, so the canvas reads through it.
