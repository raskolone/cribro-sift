# Changelog

All notable changes to Cribro Sift will be documented in this file.

## [Unreleased]

### Added
- **GSAP Smooth Orbital Stacking & Unstacking Animation for Sticky Notes (`FloatingSheetNotes`)**:
  - Refactored sticky notes animation layer to GSAP 3 with full React lifecycle cleanup via `gsap.context()` and `ctx.revert()`.
  - Implemented physical orbital folding (`0.65s`, `power3.inOut`, `0.05s` stagger, asymmetric cascade rotations `-3.8°` to `+4.2°`, scale `0.46`) and expanding (`0.75s`, `back.out(1.15)`, `0.055s` stagger, scale `1.0`).
  - Added synchronized fade-out and fade-in for note content and drag handles during transitions.
  - Implemented interruption safety for rapid toggling, full keyboard accessibility (Enter/Space on stacked top card and buttons), `aria-expanded`/`aria-label`, and `prefers-reduced-motion` support (`0.05s`).
  - Added comprehensive test suite `scripts/floating-sheets-test.js`.
- **Genie Effect Stacking Animation for Desktop Stickies (`Zwiń w stosik` / `Stack Stickies`)**:
  - Implemented smooth macOS Genie effect transition (`650ms`, `cubic-bezier(0.2, 0.9, 0.3, 1)`) animating active stickies into a compact stack in the screen corner with natural rotation angles (-3° to +3°) and subtle offsets.
  - Added physical spring overshoot (bounce-back) unstacking animation when restoring stickies to their desktop positions.
  - Added full IPC bridge support (`deck:stack`, `deck:unstack`, `deck:state`, `api.deck.onStack`).

### Changed
- **Screen Capture & OCR Modal Light/Dark Theme Overhaul**:
  - Eliminated hardcoded dark colors and aligned all OCR capture modal components with the active app theme.
  - Added semantic `--dialog-*` and `--z-*` design tokens in `tokens.css` for light (`[data-theme="light"]`) and dark (`:root`) themes.
  - Enhanced layout with pinned header/footer, scrollable content view (`overflow-y: auto`), responsive mobile scaling, and WCAG AA contrast.
  - Implemented full state machine lifecycle (`idle`, `capturing`, `processing`, `success`, `empty`, `error`, `saving`), focus trap, auto-focus, and context verification (`activeNotebookId`, `activeLessonId`, `activeStudentId`).
  - Added 18 comprehensive tests in `scripts/shot-test.js` (72/72 assertions passing).
- **Light Mode Readability & Structural Contrast Overhaul**:
  - Boosted typography to WCAG AAA standards: headings to `#020617` (slate-950), body to `#0f172a` (slate-900) & `#334155` (slate-700), metadata to `#475569` (slate-600), placeholders to `#64748b` (slate-500).
  - Enhanced container, panel, and card edge definitions with crisp borders (`rgba(15, 23, 42, 0.14)` – `rgba(15, 23, 42, 0.22)`).
  - Structured background elevation hierarchy: `#f8fafc` (slate-50) base background, `#ffffff` card/panel surfaces, and refined shadow elevation system.
- **Rich Post-it Aesthetics & Organic Paper Contour**:
  - Replaced flat colors with rich, warm classic Post-it color palettes with radial light gradients (`#fffbeb` -> `#fef08a` -> `#fde047` for yellow, rich powder pink for rose, natural chalk for graphite/white, fresh mint for moss, azure for sky, amber and violet).
  - Applied subtle organic paper curvature (`border-radius: 255px 15px 225px 15px / 15px 225px 15px 255px`) and drag handle pill indicator.
  - Added multi-layered physical paper shadow (`box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 18px -4px ..., 0 20px 32px -8px ...`) simulating peeling and lifted post-it corners.
- **Typography, Antialiasing & Contrast**:
  - Note body text set to deep saturated ink (`#0f172a` / slate-900) with weight `500` (`font-medium`) and enabled `-webkit-font-smoothing: subpixel-antialiased`.
  - Header titles given 100% high-contrast tonally matching colors per note paper tint, with larger `15px` bold typography (`font-weight: 700`).

### Fixed
- **OCR Modal Theme Inconsistency**:
  - Resolved bug where textarea turned white while surrounding modal container remained dark.
- **Tooltip Contrast on Bottom Toolbar**:
  - Corrected unreadable dark-on-dark text on action tooltips (`.note-act::after`).
  - Enforced solid dark background (`rgba(17, 24, 39, 0.92)`), 100% crisp white text (`#ffffff`), `6px` border-radius, and soft elevation shadow.
