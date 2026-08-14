import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMessageSelectionUnits,
  buildMessageTimeline,
  messageSelectionKey,
} from '../src/messageTurns.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bubble = fs.readFileSync(path.join(root, 'src/components/MessageBubble.tsx'), 'utf8');
const list = fs.readFileSync(path.join(root, 'src/components/chat/MessageList.tsx'), 'utf8');
const pane = fs.readFileSync(path.join(root, 'src/components/ChatPane.tsx'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
const header = fs.readFileSync(path.join(root, 'src/components/chat/ChatHeader.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

assert.match(bubble, /const actions = showActions \? \([\s\S]*className="msg-time"/);
assert.match(bubble, /title=\{formatMessageTimestamp\(message\.created_at\)\}/);
assert.match(css, /\.msg-actions\s*\{[\s\S]*?opacity:\s*0/);
assert.match(css, /\.msg-group:hover \.msg-actions,[\s\S]*\.msg-group\.selected \.msg-actions/);
assert.match(css, /\.msg-group:hover \.msg-actions,[\s\S]*?position:\s*static;[\s\S]*?align-self:\s*flex-end/);
assert.match(css, /@media \(hover: none\)[\s\S]*?\.msg-group:hover \.msg-actions\s*\{[\s\S]*?position:\s*absolute/);
assert.match(list, /className="unread-divider"[\s\S]*data-unread-divider=\{message\.id\}/);
assert.match(list, /new IntersectionObserver[\s\S]*document\.visibilityState !== 'visible'/);
assert.match(pane, /querySelector<HTMLElement>\(`\[data-unread-divider="\$\{firstUnreadId\}"\]`\)/);
assert.match(pane, /divider\.scrollIntoView\(\{ block: 'start' \}\)/);
// 主窗把同 turn 的 tool_use 收成默认折叠条。
assert.match(list, /buildMessageTimeline\(messages\)/);
assert.match(list, /entry\.type === 'message'/);
assert.match(list, /className=\{`side-tool-group\$\{bulkMode/);
assert.match(list, /本轮 \{entry\.messages\.length\} 次工具调用/);
assert.match(css, /\.side-tool-group\s*\{/);
const message = (id, kind, turnId, content = kind) => ({
  id,
  contact_id: 'codex',
  sender: 'codex',
  role: 'assistant',
  kind,
  content,
  status: 'done',
  turn_id: turnId,
  meta: '{}',
  origin: 'main',
  created_at: `2026-08-11T00:00:${String(id).padStart(2, '0')}.000Z`,
});
const cases = [
  {
    name: 'thinking + multiple tools + body',
    rows: [message(1, 'thinking', 'a'), message(2, 'tool_use', 'a'), message(3, 'tool_use', 'a'), message(4, 'text', 'a')],
    types: ['message', 'tools', 'message'],
    finalKey: 'message-4',
  },
  {
    name: 'no thinking + tools + body',
    rows: [message(5, 'tool_use', 'b'), message(6, 'tool_use', 'b'), message(7, 'text', 'b')],
    types: ['tools', 'message'],
    finalKey: 'message-7',
  },
  {
    name: 'thinking + tools without body',
    rows: [message(8, 'thinking', 'c'), message(9, 'tool_use', 'c'), message(10, 'tool_use', 'c')],
    types: ['message', 'tools'],
    finalKey: 'tools-c',
  },
  {
    name: 'body only',
    rows: [message(11, 'text', 'd')],
    types: ['message'],
    finalKey: 'message-11',
  },
  {
    name: 'tools only',
    rows: [message(12, 'tool_use', 'e'), message(13, 'tool_use', 'e')],
    types: ['tools'],
    finalKey: 'tools-e',
  },
];
for (const scenario of cases) {
  const timeline = buildMessageTimeline(scenario.rows);
  assert.deepEqual(timeline.map((entry) => entry.type), scenario.types, scenario.name);
  assert.deepEqual(
    timeline.filter((entry) => entry.isFinalTurnBlock).map((entry) => entry.key),
    [scenario.finalKey],
    `${scenario.name}: exactly the final rendered block owns the turn action`,
  );
}
const userMessage = {
  ...message(14, 'text', 'user-turn'),
  sender: 'user',
  role: 'user',
};
const legacyMessage = message(15, 'text', null);
const selectionRows = [
  ...cases[0].rows,
  ...cases[1].rows,
  ...cases[3].rows,
  userMessage,
  legacyMessage,
];
const selectionUnits = buildMessageSelectionUnits(selectionRows);
assert.equal(selectionUnits.length, 5, 'batch count uses assistant turns plus standalone user/legacy rows');
assert.deepEqual(selectionUnits.map((unit) => unit.messageIds), [
  [1, 2, 3, 4],
  [5, 6, 7],
  [11],
  [14],
  [15],
]);
assert.deepEqual(selectionUnits.map((unit) => unit.deleteScope ?? null), ['turn', 'turn', 'turn', null, null]);
assert.equal(messageSelectionKey(cases[0].rows[0]), messageSelectionKey(cases[0].rows[3]));
assert.notEqual(messageSelectionKey(userMessage), messageSelectionKey(message(16, 'text', 'user-turn')));
assert.notEqual(messageSelectionKey(legacyMessage), messageSelectionKey(message(17, 'text', null)));
assert.match(list, /deleteScope: entry\.turnId \? 'turn' : undefined/);
assert.match(pane, /api\.deleteMessage\(contact\.id, m\.id, scope \? \{ scope \} : undefined\)/);
assert.match(pane, /buildMessageSelectionUnits\(channelMessages\)/);
assert.match(pane, /unit\.deleteScope \? \{ scope: unit\.deleteScope \} : undefined/);
assert.match(list, /bulkKeys\.has\(messageSelectionKey\(message\)\)/);
assert.match(bubble, /onBulkMessageToggle\?\.\(message\)/);
assert.match(list, /bulkMode && showBulkMark/);
assert.match(css, /\.side-tool-group\.bulk-selected/);
assert.match(css, /\.message-scroll > \.same-turn-continuation\s*\{[\s\S]*margin-top:\s*calc\(8px - var\(--gap-turn\)\)/);
assert.doesNotMatch(header, /主窗 \/ 后台|sideUnread|onToggleChannel/);
assert.doesNotMatch(pane, /sideQuote|sideChannel|引原文|副窗只读/);
assert.doesNotMatch(bubble, /onQuoteToMain|sideSourceLabel/);
assert.doesNotMatch(app, /loadChannel\('side'\)|sideUnread/);
assert.equal(fs.existsSync(path.join(root, 'src/sideChannel.ts')), false);
assert.equal(fs.existsSync(path.join(root, 'src/sideQuote.ts')), false);

console.log('message time and unread presentation checks passed');
