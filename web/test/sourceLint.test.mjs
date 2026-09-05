import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const styles = path.join(root, 'src', 'styles');
for (const name of fs.readdirSync(styles).filter((file) => file.endsWith('.css'))) {
  const source = fs.readFileSync(path.join(styles, name), 'utf8');
  assert.doesNotMatch(source, /transition\s*:\s*all\b/i, `${name} must name transitioned properties`);
  if (name === 'motion.css') continue;
  for (const line of source.split(/\r?\n/)) {
    if (!/\b(?:transition|animation)\s*:/i.test(line)) continue;
    assert.doesNotMatch(
      line,
      /(?<![-\w])(?:\d*\.\d+|\d+)m?s\b/i,
      `${name} has a motion duration outside motion.css: ${line.trim()}`,
    );
    assert.doesNotMatch(line, /(?<![-\w])ease(?:-in|-out|-in-out)?\b/i, `${name} has a hard-coded easing`);
    assert.doesNotMatch(line, /cubic-bezier\(/i, `${name} has a hard-coded easing`);
  }
}

console.log('source lint passed: CSS motion declarations use centralized tokens');
