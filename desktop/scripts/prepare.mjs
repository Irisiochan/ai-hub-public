// Stage the built server + web bundles into desktop/ so both `electron .`
// and electron-builder see one consistent layout:
//   desktop/server-dist/  ← server/dist (ESM, marked type:module)
//   desktop/web-dist/     ← web/dist
// Bare imports inside server-dist resolve against desktop/node_modules,
// where native deps are rebuilt for Electron's ABI (postinstall).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopRoot, '..');

const stages = [
  { from: path.join(repoRoot, 'server', 'dist'), to: path.join(desktopRoot, 'server-dist'), hint: 'npm run build --prefix server' },
  { from: path.join(repoRoot, 'web', 'dist'), to: path.join(desktopRoot, 'web-dist'), hint: 'npm run build --prefix web' },
];

for (const { from, to, hint } of stages) {
  if (!fs.existsSync(from)) {
    console.error(`missing ${from} — run \`${hint}\` first`);
    process.exit(1);
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  console.log(`staged ${path.basename(from) === 'dist' ? from : from} → ${to}`);
}

// server/dist relies on server/package.json's "type": "module"; re-declare it
// here so Node keeps treating the staged .js files as ESM.
fs.writeFileSync(
  path.join(desktopRoot, 'server-dist', 'package.json'),
  JSON.stringify({ type: 'module' }, null, 2) + '\n',
  'utf8'
);
console.log('done');
