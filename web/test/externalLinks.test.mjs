import assert from 'node:assert/strict';
import {
  closeExternalLink,
  openExternalLink,
  shouldOpenInExternalView,
} from '../src/externalLinks.ts';

const current = 'http://localhost:5173/chat';

assert.equal(shouldOpenInExternalView('https://example.com/same-style', current), true);
const view = openExternalLink('https://example.com/same-style');
assert.deepEqual(view, { url: 'https://example.com/same-style' });
assert.equal(closeExternalLink(), null);

assert.equal(shouldOpenInExternalView('/contacts', current), false);
assert.equal(shouldOpenInExternalView('http://localhost:5173/settings', current), false);
assert.equal(shouldOpenInExternalView('mailto:hello@example.com', current), false);

console.log('external link view tests passed');
