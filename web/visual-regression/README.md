# Visual regression baselines

This fixture freezes the pre-refactor appearance of the AI Hub web UI at commit
5f1ba0bcd212190abc4311a92300e0eef27785e8. It uses fixed local markup and data,
the production stylesheet entry, Vite, and the installed Chrome/Chromium binary;
no backend or network data is required.

The eight PNGs in `baseline/` freeze the pre-Telegram-shell appearance. The
eight PNGs in `after/` use the same contacts/private/group/Worker scenario and
1440 px desktop + 375 px mobile matrix after the intentional shell redesign.
Together they cover turn clusters, incoming/outgoing bubbles, a collapsed
process strip, code card, Worker receipt, JobThread, RuntimeDrawer, floating
Composer, and attachment preview.

Run from web/:

    node visual-regression/capture.mjs --output=visual-regression/after
    node visual-regression/verify-layout.mjs

ThemeManifest baselines use the same deterministic fixture plus the theme
settings panel:

    node visual-regression/capture.mjs --theme=violet-purple --mode=dark --output=visual-regression/themes/violet-purple-dark
    node visual-regression/capture.mjs --theme=violet-purple --mode=light --output=visual-regression/themes/violet-purple-light
    node visual-regression/capture.mjs --theme=quiet-mint --mode=dark --output=visual-regression/themes/quiet-mint-dark

The wallpapers are original AI Hub SVG patterns documented in
`public/themes/README.md`. Theme packages can select only bundled wallpaper IDs.

`compare.mjs` remains the byte-exact guard for reproducing an existing set; it
is not used to compare `baseline/` to `after/`, because this task intentionally
changes every shell screenshot.

`verify-layout.mjs` opens all four scenarios at 375 px and fails on page or
message-pane horizontal overflow (and on a fixture that unexpectedly starts
scrolled away from the top).

The comparison is deliberately stricter than a pixel threshold: PNG bytes must
match exactly. Set CHROME_PATH when Chrome/Chromium is not in a standard path.
Animations and transitions are disabled only inside the deterministic fixture.
