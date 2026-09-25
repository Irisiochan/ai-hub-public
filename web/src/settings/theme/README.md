# ThemeManifest v1

Theme packages are JSON data, not executable extensions. `schema.ts` uses strict
Zod objects: unknown keys fail validation, colors must be literal color values,
and wallpaper assets are selected from a built-in ID enum. There is no field for
CSS, JavaScript, HTML, remote URLs, data URIs, or arbitrary files.

## Fields

- metadata: `version`, `id`, `name`, `description`, `author`
- `variants.light` and `variants.dark`
  - `primary`: accent, soft, line, glow, ink, text
  - `surfaces`: background, canvas, panel, rail, elevated, card, hover, raised, code
  - `text`: primary, body, dim, muted, onOutgoing
  - `borders`: subtle, strong
  - `bubbles`: incoming/outgoing colors, text colors, and structured gradients
  - `wallpaper`: allow-listed asset ID, background color, tile size
  - `icons`: default, muted, active
  - `status`: success/error semantic colors
- `wallpaperAttribution`: source and license text
- `sounds`: safe pack/clip references; `builtin-synth` selects the repository's
  Web Audio oscillator/envelope cues. The reference remains the future pack seam.
- `animation`: reduced, standard, or expressive theme default

`store.ts` maps the active variant to the variables declared in
`styles/tokens.css`. The external store changes the document root directly, so
theme changes do not enter `App`, `ChatPane`, the message array, or memoized
message props. Selection, mode, and validated imported manifests are persisted
in localStorage. `preferences/store.ts` resolves the theme animation default to
the user-facing off/reduced/full levels. With no explicit user value it follows
`prefers-reduced-motion`; once selected, the user value overrides both system
and theme. Motion and sound settings use versioned localStorage keys in the same
style as the theme store.
