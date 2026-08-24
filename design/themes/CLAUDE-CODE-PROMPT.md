# Opening instruction for Claude Code

Paste this as your first message in the repo you are theming.

---

I'm applying a shared visual theme across all of my applications. This repo is one
of them. The theme package is in `design/theme/` — read every file there before
you change anything:

- `README.md` — the direction and the rules
- `tokens.css` — the tokens; the only place a raw hex, font name or radius may appear
- `components.md` — the recipes for each UI element
- `tailwind.config.snippet.js` — merge into the Tailwind config if this repo uses Tailwind
- `constellation.js` — the background canvas

## What I want you to do

1. Read the package, then read this repo's existing styles and component layer.
   Report back: which files hold color/type/spacing today, and what your migration
   plan is. **Do not write code yet.**
2. Import `tokens.css` globally, once, at the app root.
3. Replace hard-coded colors, fonts, radii, shadows and spacing with `var(--*)`
   tokens. If a value in this repo has no matching token, tell me — do not invent a
   new hex or add a token silently.
4. Migrate components in this order: buttons, inputs, cards, nav, then everything
   else. One component per commit, message `theme: <component>`.
5. Add the constellation canvas at the app shell level: the canvas as the first
   child of the root, all existing content wrapped in
   `position: relative; z-index: 1`. The page gradient goes on `body`.

## Constraints

- Do not change any application logic, data flow, routing, or copy. Visual layer only.
- Do not add a UI library, a CSS-in-JS runtime, or new dependencies. Fonts and the
  Phosphor icon sheet are the only external assets.
- Do not restyle per-page. If two pages need the same button, they use the same class.
- Keep dark mode as the only mode unless I ask for a light variant.
- Preserve accessibility: `:focus-visible` rings stay, `prefers-reduced-motion`
  is respected, body text keeps at least 4.5:1 against its surface. Accent-colored
  text is for large type and labels only.

Start with step 1 and wait for my go-ahead.
