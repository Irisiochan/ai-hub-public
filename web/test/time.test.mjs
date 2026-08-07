import assert from 'node:assert/strict';
import { formatConversationListTime, formatMessageTimestamp } from '../src/time.ts';

const shanghaiAfternoon = new Date('2026-08-02T09:45:00Z');

assert.equal(
  formatConversationListTime('2026-08-02 01:32:45', shanghaiAfternoon),
  '09:32',
  'conversation list renders same-day SQLite timestamps in Shanghai time'
);
assert.equal(
  formatConversationListTime('2026-08-01T16:30:00Z', shanghaiAfternoon),
  '00:30',
  'conversation list uses the Shanghai date boundary instead of the device or UTC date'
);
assert.equal(
  formatConversationListTime('2026-08-01T15:59:59Z', shanghaiAfternoon),
  '8/1',
  'conversation list renders older dates using the Shanghai calendar day'
);

assert.equal(
  formatMessageTimestamp('2026-08-02 01:32:45'),
  '2026/08/02 09:32:45',
  'SQLite UTC timestamps render as a locale-independent full Shanghai date and time'
);
assert.equal(
  formatMessageTimestamp('2026-08-02T01:32:45Z'),
  '2026/08/02 09:32:45',
  'ISO timestamps use the same stable display format'
);

console.log('message timestamp tests passed');
