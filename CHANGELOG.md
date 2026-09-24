# Changelog

All notable changes to Cribro Sift will be documented in this file.

## [Unreleased]

### Added
- **Genie Effect Stacking Animation for Stickies (`Zwiń w stosik` / `Stack Stickies`)**:
  - Implemented smooth macOS Genie effect transition (`650ms`, `cubic-bezier(0.2, 0.9, 0.3, 1)`) animating active stickies into a compact stack in the screen corner with natural rotation angles (-3° to +3°) and subtle offsets.
  - Added physical spring overshoot (bounce-back) unstacking animation when restoring stickies to their desktop positions.
  - Exposes the desktop underneath for selecting and copying content from underlying application windows.
  - Added full IPC bridge support (`deck:stack`, `deck:unstack`, `deck:state`, `api.deck.onStack`).

### Changed
- **Rich Post-it Aesthetics & Organic Paper Contour**:
  - Replaced flat colors with rich, warm classic Post-it color palettes with radial light gradients (`#fffbeb` -> `#fef08a` -> `#fde047` for yellow, rich powder pink for rose, natural chalk for graphite/white, fresh mint for moss, azure for sky, amber and violet).
  - Applied subtle organic paper curvature (`border-radius: 255px 15px 225px 15px / 15px 225px 15px 255px`).
  - Added multi-layered physical paper shadow (`box-shadow: 0 1px 3px rgba(0,0,0,0.08), 0 8px 18px -4px ..., 0 20px 32px -8px ...`) simulating peeling and lifted post-it corners.
- **Typography, Antialiasing & Contrast**:
  - Note body text set to deep saturated ink (`#0f172a` / slate-900) with weight `500` (`font-medium`) and enabled `-webkit-font-smoothing: subpixel-antialiased`.
  - Header titles given 100% high-contrast tonally matching colors per note paper tint (deep sepia `#451a03` for yellow/amber, deep burgundy `#4c0519` for rose, anthracite `#09090b` for white, deep forest `#064e3b` for moss, deep navy `#0c4a6e` for sky, deep violet `#3b0764` for violet), with larger `15px` bold typography (`font-weight: 700`).

### Fixed
- **Tooltip Contrast on Bottom Toolbar**:
  - Corrected unreadable dark-on-dark text on action tooltips (`.note-act::after`).
  - Enforced solid dark background (`rgba(17, 24, 39, 0.92)`), 100% crisp white text (`#ffffff`), `6px` border-radius, and soft elevation shadow.
