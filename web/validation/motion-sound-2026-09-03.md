# Motion and sound validation — 2026-09-03

Baseline: `master` at `b4105b26c3af004f3f6183040d35cd00c48a6a1a`, clean worktree.

## Motion token convergence

Command:

```powershell
rg --pcre2 -n -i "(?:transition|animation)\s*:[^;\r\n]*(?<![-\w])(?:[0-9]*\.?[0-9]+)(?:ms|s)\b|(?:transition|animation)\s*:[^;\r\n]*(?<![-\w])ease(?:-in|-out|-in-out)?\b|(?:transition|animation)\s*:[^;\r\n]*cubic-bezier\(" web/src/styles -g '*.css' -g '!motion.css'
```

Result: no matches (`NO_HARDCODED_MOTION_OUTSIDE_MOTION_CSS`). Non-zero
durations and the shared `cubic-bezier(.4, 0, .2, 1)` live only in
`src/styles/motion.css`; `0ms` is used only by the off override.

## Motion levels and 375px layout

`npm run test:browser-motion` used installed headless Chrome through the DevTools
Performance domain:

- full: contact transition `contact-enter`, duration `0.3s`;
- reduced: contact transition becomes opacity-only `fade-enter`, and computed
  transition property is `opacity`;
- off: computed animation and transition durations are `0s`;
- 375x812 settings card bounds were x=21..354, page overflow 0px, and the
  full-width preview button measured 301px;
- all existing 375px fixture scenarios (`contacts`, `private`, `group`,
  `worker`, `themes`) passed with no horizontal overflow or console errors.

## Sound event matrix

`npm test` instruments the Web Audio oscillator/gain nodes. Send, assistant
complete, Worker complete, and error each fired once in all three contexts:
current conversation + foreground, other conversation + foreground, and page
background. A repeated background assistant event stayed silent. Two unique
send events inside the throttle window produced true/false. The longest cue is
220ms; send throttle is 300ms; send gain is 45% of the loudest cue baseline.

The runtime context is computed with `document.visibilityState` and the current
contact ref. Event IDs are claimed with Web Locks plus versioned localStorage,
so SSE reconnects, history reconciliation, and other Chromium tabs cannot replay
the same cue. AudioContext is created/resumed only after pointer or keyboard
interaction; a blocked context returns silently.

## Streaming performance boundary

The delta handler still only calls `MessageDeltaBatcher.add`. Motion attributes
are stable for an existing row, so delta content changes never toggle a motion
class. Thinking/tool disclosure motion is mounted only under the click-controlled
`processOpen` branch.

- existing long-session test: 1,000 deltas -> 20 state updates, 200 maximum
  rendered messages, one observer setup;
- Chrome Performance check: 20 delta-like paint frames caused 20 layouts and 21
  style recalculations required by changing text; CSS animations before/after
  were identical (`breathe`, `contact-enter`, `pulse`), new animations: 0.

## Commands

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run test:browser-motion`
- `node visual-regression/verify-layout.mjs`

Only `web` is affected; no server or Worker tests are required by the diff.
