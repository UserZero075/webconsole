# Embedded terminal geometry

The workspace terminal uses the standalone console page in an iframe. FitAddon sizes xterm from its parent container; CSS must not move or enlarge the rendered grid independently of that calculation.

## Regression and fix

The former embedded `.xterm` rule used `margin: -16px` and `width`/`height: calc(100% + 32px)`. This shifted the grid outside its clipping wrapper without adding rows or columns. The embedded rule now keeps xterm at `100%` with no margin or padding. The `.xterm-screen` dimensions remain under xterm's renderer control.

The viewport's background is also controlled by xterm. A CSS `!important` background on `.xterm-viewport` prevented OSC 11 from updating the visible background; a fixed screen background caused the same mismatch. Those forced colors have been removed. The configured terminal background remains the initial/reset background, and SGR cell colors remain independent.

The normal scroll position, xterm grid, standalone terminal padding, and PTY sizing logic are unchanged. Small gaps below one cell can remain because xterm uses whole rows and columns; the regression checks they are less than a cell rather than stretching or clipping the grid to force zero gap.

## Verification

`tools/mobile-tests/terminal-geometry.spec.mjs` exercises the real workspace and console templates with a fixture session and synthetic terminal output. It checks corner glyphs and geometry at 320, 360, 390, 430, 844×390, and 1920px widths, plus DPR 2.75. It also checks OSC 11, OSC 111, explicit theme changes, and an SGR cell background.

Run Chromium coverage:

```sh
npm --prefix tools/mobile-tests test -- --project=chromium
node --test tests/frontend/*.test.mjs tests/frontend/mobile/*.test.mjs
.venv/bin/python -m pytest tests -q
```

WebKit geometry coverage is opt-in and requires its Playwright browser to be installed:

```sh
WEBCONSOLE_TEST_WEBKIT=1 npm --prefix tools/mobile-tests test -- --project=webkit-geometry
```

The implementation was verified in Chromium only in the current test run. WebKit browser installation and physical Android/iPhone acceptance remain unverified. Browser automation uses synthetic fixture data and does not attach to real sessions.
