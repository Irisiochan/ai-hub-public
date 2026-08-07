import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src');
const sourceFiles = [];
const collect = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) sourceFiles.push(full);
  }
};
collect(src);

const allSource = sourceFiles.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
const dialog = fs.readFileSync(path.join(src, 'components/ConfirmDialog.tsx'), 'utf8');
const main = fs.readFileSync(path.join(src, 'main.tsx'), 'utf8');

assert.doesNotMatch(allSource, /window\.confirm\s*\(/, 'native confirm must not re-enter the Electron Windows focus bug');
assert.match(main, /<ConfirmProvider>/, 'the shared async confirm provider must wrap every app surface');
assert.match(dialog, /document\.activeElement/, 'opening a confirmation must capture the current focus owner');
assert.match(dialog, /returnFocus\?\.isConnected/, 'focus restoration must avoid detached elements');
assert.match(dialog, /requestAnimationFrame/, 'focus must be restored after the dialog unmounts');
assert.match(dialog, /focus\(\{ preventScroll: true \}\)/, 'closing must restore the pre-dialog element without jumping the page');
assert.match(dialog, /role="dialog"/);
assert.match(dialog, /aria-modal="true"/);
assert.match(dialog, /event\.key === 'Escape'/, 'Escape must cancel the confirmation');
assert.match(dialog, /event\.key !== 'Tab'/, 'keyboard focus must stay trapped inside the modal');
assert.match(dialog, /createPortal\(/, 'the dialog must escape clipped nested panels');
assert.match(dialog, /autoFocus/, 'the safe cancel action must receive initial focus');

for (const file of [
  'components/ChatPane.tsx',
  'components/ContactConfig.tsx',
  'components/JobThread.tsx',
  'components/WorkerPanel.tsx',
  'components/chat/SideJobActions.tsx',
]) {
  assert.match(fs.readFileSync(path.join(src, file), 'utf8'), /useConfirm\(/, `${file} must use the shared dialog`);
}

console.log('async confirm dialog focus checks passed');
