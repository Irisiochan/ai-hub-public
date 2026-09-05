import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_THEMES, VIOLET_PURPLE_THEME } from '../src/theme/builtins.ts';
import { parseThemeManifest } from '../src/theme/schema.ts';
import {
  exportCurrentTheme,
  getThemeSnapshot,
  importThemePackage,
  initializeThemeSystem,
  selectTheme,
  setThemeMode,
  themeCssTokens,
} from '../src/theme/store.ts';

for (const theme of BUILTIN_THEMES) assert.deepEqual(parseThemeManifest(theme), theme);

const tokens = themeCssTokens(VIOLET_PURPLE_THEME, 'dark');
for (const token of [
  '--accent', '--bg-canvas', '--bg-card', '--bubble-mine-bg', '--bubble-theirs-bg',
  '--chat-wallpaper', '--icon-active',
]) assert.equal(typeof tokens[token], 'string', `${token} must be mapped`);
assert.equal(tokens['--bg'], '#0d0e13');
assert.equal(tokens['--bubble-mine'], '#4a3f78');
assert.equal(tokens['--chat-wallpaper'], 'url("/themes/violet-bloom.svg")');
assert.equal(VIOLET_PURPLE_THEME.sounds.packId, 'builtin-synth');

const hostile = structuredClone(VIOLET_PURPLE_THEME);
hostile.variants.dark.primary.accent = 'url(javascript:alert(1))';
assert.throws(() => parseThemeManifest(hostile), /literal CSS color/);

const unknown = { ...structuredClone(VIOLET_PURPLE_THEME), stylesheet: 'https://example.com/theme.css' };
assert.throws(() => parseThemeManifest(unknown), /Unrecognized key/);

const script = { ...structuredClone(VIOLET_PURPLE_THEME), script: 'alert(1)' };
assert.throws(() => parseThemeManifest(script), /Unrecognized key/);

const remoteWallpaper = structuredClone(VIOLET_PURPLE_THEME);
remoteWallpaper.variants.dark.wallpaper.asset = 'https://example.com/a.svg';
assert.throws(() => parseThemeManifest(remoteWallpaper));

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
  clear: () => stored.clear(),
  key: (index) => [...stored.keys()][index] ?? null,
  get length() { return stored.size; },
};
initializeThemeSystem();
setThemeMode('light');
selectTheme('quiet-mint');
assert.equal(getThemeSnapshot().mode, 'light');
assert.equal(getThemeSnapshot().selectedId, 'quiet-mint');
const imported = structuredClone(VIOLET_PURPLE_THEME);
imported.id = 'local-custom';
imported.name = '本地自定义';
assert.equal(importThemePackage(JSON.stringify(imported)).id, 'local-custom');
assert.equal(getThemeSnapshot().selectedId, 'local-custom');
assert.equal(JSON.parse(exportCurrentTheme()).id, 'local-custom');
assert.match(stored.get('ai-hub.theme.imported.v1'), /local-custom/);
assert.throws(() => importThemePackage(JSON.stringify(VIOLET_PURPLE_THEME)), /不能覆盖内置主题/);
delete globalThis.localStorage;

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
const pane = fs.readFileSync(path.join(root, 'src/components/ChatPane.tsx'), 'utf8');
assert.doesNotMatch(app, /useState[^\n]*theme/i, 'theme changes must not enter App state');
assert.doesNotMatch(pane, /themeManifest|selectedTheme|themeMode/i, 'theme props must not enter chat rendering');

console.log('ThemeManifest schema, token mapping, injection rejection, and render isolation checks passed');
