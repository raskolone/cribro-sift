# Component recipes

Every value below references a token from `tokens.css`. Copy the recipe, not the hex.

---

## Card (the workhorse surface)

```css
.card {
  padding: var(--s-6);
  border-radius: var(--r-xl);
  background: var(--surface-gradient);
  border: 1px solid var(--line);
  box-shadow: var(--shadow-lg);
  backdrop-filter: blur(12px);
  transition: transform var(--t), border-color var(--t), box-shadow var(--t);
}
.card:hover {
  transform: translateY(-2px);
  border-color: var(--accent-25);
  box-shadow: var(--shadow-lg), var(--glow);
}
```

Anatomy, top to bottom: a Phosphor icon at 26px in `--accent`, an `h3` at
`--fs-h3` in `--text-hi` (18px above, 10px below), body copy at `--fs-sm`
in `--text-3`. A card with a mono kicker puts `.label` above the icon instead.

**Selected state** — for pickable cards: border `--accent-30`, background gains
`--accent-08`, box-shadow `var(--glow)`. Never change the size.

## Buttons

Primary — the one main action per screen, the only accent flood allowed:
```css
.btn-primary {
  padding: 11px 22px; border: none; border-radius: var(--r-sm);
  background: var(--accent); color: var(--accent-ink);
  font: 700 var(--fs-xs) var(--font-body); cursor: pointer;
  box-shadow: var(--glow-btn);
  transition: filter var(--t), transform var(--t);
}
.btn-primary:hover  { filter: brightness(1.08); transform: translateY(-1px); }
.btn-primary:active { transform: translateY(0); filter: brightness(0.94); }
```

Secondary — outlined, translucent accent. This is the default button:
```css
.btn-secondary {
  padding: 9px 22px; border-radius: var(--r-pill);
  border: 1px solid var(--accent-25);
  background: linear-gradient(135deg, var(--accent-15), var(--accent-04));
  color: var(--accent); font: 500 var(--fs-xs) var(--font-body); cursor: pointer;
  transition: border-color var(--t), box-shadow var(--t), transform var(--t);
}
.btn-secondary:hover { border-color: var(--accent-55); box-shadow: var(--glow); transform: translateY(-1px); }
```

Ghost — tertiary, mono label:
```css
.btn-ghost {
  padding: 11px; border-radius: var(--r-sm);
  background: rgba(255,255,255,0.04); border: 1px solid var(--line-strong);
  color: var(--text-2); font: 500 11.5px var(--font-mono);
  letter-spacing: 0.06em; cursor: pointer; transition: all var(--t);
}
.btn-ghost:hover { background: rgba(255,255,255,0.07); color: var(--text); }
```

Disabled, all variants: `opacity: 0.45; pointer-events: none;`.

## Badge / pill

```css
.badge {
  display: inline-flex; align-items: center; gap: var(--s-2);
  padding: 5px 12px; border-radius: var(--r-pill);
  background: var(--accent-12); border: 1px solid var(--accent-30);
  color: var(--accent); font: 500 11px var(--font-mono);
  letter-spacing: 0.1em; text-transform: uppercase;
}
```
State variants swap the hue only: `--warn` / `--danger` / `--info` at the same
12% fill and 30% border. Do not add a fourth decorative color.

## Input & text well

```css
.input {
  width: 100%; padding: var(--s-4);
  background: var(--ink); border: 1px solid var(--line-strong);
  border-radius: var(--r-md); color: var(--text);
  font: 400 var(--fs-body) var(--font-body);
  transition: border-color var(--t), box-shadow var(--t);
}
.input::placeholder { color: var(--text-faint); }
.input:focus { outline: none; border-color: var(--accent-55); box-shadow: var(--glow); }
```
Field label above: `.label` in `--accent`, 10px gap.

## Sticky nav

```css
.nav {
  position: sticky; top: 0; z-index: 50;
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--s-4) var(--s-12);
  background: var(--glass); backdrop-filter: blur(24px);
  border-bottom: 1px solid var(--line);
}
```
Nav links: `--fs-xs`, weight 500, `--text-mute`; active or hover → `--accent`.

## Progress bar

```css
.track { height: 4px; border-radius: var(--r-pill); background: rgba(255,255,255,0.08); overflow: hidden; }
.fill  { height: 100%; border-radius: var(--r-pill); background: var(--accent);
         box-shadow: 0 0 12px var(--accent-55); transition: width var(--t-slow); }
```
A 2px page-scroll variant sits `position: fixed; top: 0` with
`background: linear-gradient(90deg, transparent, var(--accent))`.

## List row (prefer over a grid of cards for dense data)

```css
.row {
  display: flex; align-items: center; gap: var(--s-4);
  padding: var(--s-4) var(--s-5);
  border-bottom: 1px solid var(--line-soft);
  transition: background var(--t);
}
.row:hover { background: rgba(255,255,255,0.03); }
.row:last-child { border-bottom: none; }
```

## Table

Header: `.label` cells, `border-bottom: 1px solid var(--line-strong)`, padding
`var(--s-3) var(--s-4)`. Body cells at `--fs-sm`, row rules at `--line-soft`.
Numbers in `--font-mono`. No zebra striping.

## Modal

```css
.backdrop { position: fixed; inset: 0; z-index: 100;
  background: rgba(5,7,13,0.72); backdrop-filter: blur(8px);
  display: grid; place-items: center; }
.dialog { width: min(520px, calc(100vw - 32px)); padding: var(--s-8);
  border-radius: var(--r-xl); background: var(--surface-flat);
  border: 1px solid var(--line-strong); box-shadow: var(--shadow-lg); }
```

## Stat block

Number: `--font-display`, 52px, weight 700, `--accent`, `line-height: 1`.
Caption below at 8px gap: `.label`.

---

## Layout

Content max-width `1320px`, page padding `var(--s-12)` desktop / `var(--s-5)`
mobile. Section rhythm: `var(--s-28)` bottom padding. Always lay out sibling
groups with flex/grid and `gap` — never margins on children.

## Motion

Entrances: 40–70px rise + fade, 0.9s `power3.out`, stagger 0.1s. Reveal on scroll
at `top 88%`. Hover: 1–2px lift, 0.2s. Glow pulses only on a live/recording state.
Respect `prefers-reduced-motion`.
