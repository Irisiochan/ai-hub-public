/**
 * Room thinking labels must use the member display name, never the room title.
 * Regression: mid-turn resync used to drop `member`, and typing-hint fell back
 * to contact.name → 「会议室 思考中」.
 */
import assert from 'node:assert/strict';
import { statusText } from '../src/statusText.ts';

// Room with member → member name
assert.equal(
  statusText({ state: 'thinking', member: '示例助手' }, { isRoom: true, contactName: '会议室' }),
  '示例助手 思考中…'
);

// Room WITHOUT member → must NOT use room title
const roomNoMember = statusText(
  { state: 'thinking' },
  { isRoom: true, contactName: '会议室' }
);
assert.equal(roomNoMember, '思考中…');
assert.ok(!roomNoMember.includes('会议室'), `room title leaked: ${roomNoMember}`);

// DM without member may show contact name
assert.equal(
  statusText({ state: 'thinking' }, { isRoom: false, contactName: 'glm' }),
  'glm 思考中…'
);

// Streaming / tool paths keep member
assert.equal(
  statusText({ state: 'streaming', member: '示例助手' }, { isRoom: true, contactName: '会议室' }),
  '示例助手 正在输入…'
);
assert.equal(
  statusText({ state: 'tool:search_vault', member: '示例助手' }, { isRoom: true, contactName: '会议室' }),
  '示例助手 正在用 search_vault'
);

console.log('statusText: ok');
