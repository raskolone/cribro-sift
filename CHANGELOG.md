# Changelog

All notable changes to Cribro Sift will be documented in this file.

## [Unreleased]

### Added
- **Card Stacking Animation for Stickies (`Zwiń w stosik` / `Stack Stickies`)**:
  - Replaced the simple hide switch button on stickies with a matte, paper-harmonic stack button.
  - Implemented smooth cubic-bezier (`transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1)`) transition animating active stickies into a compact stack in the screen corner with natural rotation angles (-3° to +3°) and subtle offsets.
  - Exposes the desktop underneath for selecting and copying content from underlying application windows.
  - Clicking on the stacked card or triggering the toggle unrolls and restores all stickies smoothly to their original desktop positions and dimensions.
  - Added full IPC bridge support (`deck:stack`, `deck:unstack`, `deck:state`, `api.deck.onStack`).

### Changed
- **Paper Look & Feel (Aesthetics & Materials)**:
  - Replaced bright plastic pastels with warm, toned, and matte paper color palettes (Manila/parchment `#fbf3d5`, soft powder rose `#f7e6e8`, natural linen/chalk `#fafaf9`, and softened tones for graphite, moss, sky, amber, and violet).
  - Added soft, physical warm paper elevation shadows (`box-shadow: 0 14px 34px -10px rgba(70,55,25,0.22)`) and refined borders.
  - Redesigned the bottom button capsule to a clean, minimal matte paper style.
- **Typography & Contrast**:
  - Note body text enhanced to high-contrast deep charcoal (`#1f2937` / neutral-800) with weight `450` for optimal readability.
  - Note header titles increased in size (`14px` / `text-base`), weighted at `650` (semi-bold/bold), and given color-accented tone bars tailored to each note paper tint (ochre for yellow, deep plum for rose, dark emerald for moss, etc.).

### Fixed
- **Tooltip Contrast on Bottom Toolbar**:
  - Corrected unreadable dark-on-dark text on action tooltips (`.note-act::after`).
  - Enforced solid dark background (`rgba(17, 24, 39, 0.92)`), 100% crisp white text (`#ffffff`), `6px` border-radius, and soft elevation shadow.
