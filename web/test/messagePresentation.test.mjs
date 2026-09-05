import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildMessageSelectionUnits,
  buildMessageTimeline,
  messageSelectionKey,
  sameMessageReferences,
} from '../src/messageTurns.ts';
import { displayedErrorContent, interruptionReason } from '../src/interruptionReason.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bubble = fs.readFileSync(path.join(root, 'src/components/MessageBubble.tsx'), 'utf8');
const list = fs.readFileSync(path.join(root, 'src/components/chat/MessageList.tsx'), 'utf8');
const pane = fs.readFileSync(path.join(root, 'src/components/ChatPane.tsx'), 'utf8');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
const header = fs.readFileSync(path.join(root, 'src/components/chat/ChatHeader.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles/theme.css'), 'utf8');

assert.match(bubble, /const actions = showActions \? \([\s\S]*className="msg-time"/);
assert.match(bubble, /title=\{formatMessageTimestamp\(message\.created_at\)\}/);
assert.match(css, /\.msg-actions\s*\{[\s\S]*?opacity:\s*0/);
assert.match(css, /\.msg-group:hover \.msg-actions,[\s\S]*\.msg-group\.selected \.msg-actions/);
assert.match(css, /\.msg-group:hover \.msg-actions,[\s\S]*?position:\s*static;[\s\S]*?align-self:\s*flex-end/);
assert.match(css, /@media \(hover: none\)[\s\S]*?\.msg-group:hover \.msg-actions\s*\{[\s\S]*?position:\s*absolute/);
assert.match(list, /className="unread-divider"[\s\S]*data-unread-divider=\{message\.id\}/);
assert.match(list, /new IntersectionObserver[\s\S]*document\.visibilityState !== 'visible'/);
assert.match(pane, /querySelector<HTMLElement>\(`\[data-unread-divider="\$\{unreadDividerId\}"\]`\)/);
assert.match(pane, /divider\.scrollIntoView\(\{ block: 'start' \}\)/);
// 主窗把同 turn 的 thinking/tool/body 收成一个 memoized cluster。
assert.match(list, /buildMessageTimeline\(visibleMessages\)/);
assert.match(list, /entry\.type === 'message'/);
assert.match(list, /const AssistantTurnCluster = memo/);
assert.match(list, /className="turn-process"/);
assert.match(list, /sameMessageReferences\(previous\.messages, next\.messages\)/);
assert.match(css, /\.assistant-turn-cluster\s*\{/);
assert.match(css, /\.proc-strip\s*\{/);
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
    types: ['turn'],
  },
  {
    name: 'no thinking + tools + body',
    rows: [message(5, 'tool_use', 'b'), message(6, 'tool_use', 'b'), message(7, 'text', 'b')],
    types: ['turn'],
  },
  {
    name: 'thinking + tools without body',
    rows: [message(8, 'thinking', 'c'), message(9, 'tool_use', 'c'), message(10, 'tool_use', 'c')],
    types: ['turn'],
  },
  {
    name: 'body only',
    rows: [message(11, 'text', 'd')],
    types: ['turn'],
  },
  {
    name: 'tools only',
    rows: [message(12, 'tool_use', 'e'), message(13, 'tool_use', 'e')],
    types: ['turn'],
  },
];
for (const scenario of cases) {
  const timeline = buildMessageTimeline(scenario.rows);
  assert.deepEqual(timeline.map((entry) => entry.type), scenario.types, scenario.name);
  assert.deepEqual(timeline[0].messages, scenario.rows, `${scenario.name}: one durable cluster keeps every row`);
}
const preserved = [...cases[0].rows];
assert.equal(sameMessageReferences(cases[0].rows, preserved), true);
assert.equal(sameMessageReferences(cases[0].rows, [...preserved.slice(0, -1), { ...preserved.at(-1) }]), false);
const errorRow = { ...message(18, 'error', 'error-turn'), status: 'error' };
assert.deepEqual(buildMessageTimeline([message(17, 'thinking', 'error-turn'), errorRow]).map((entry) => entry.type), ['turn', 'message']);
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
assert.match(list, /deleteScope="turn"/);
assert.match(pane, /api\.deleteMessage\(contact\.id, m\.id, scope \? \{ scope \} : undefined\)/);
assert.match(pane, /buildMessageSelectionUnits\(channelMessages\)/);
assert.match(pane, /unit\.deleteScope \? \{ scope: unit\.deleteScope \} : undefined/);
assert.match(list, /bulkKeys\.has\(messageSelectionKey\(message\)\)/);
assert.match(bubble, /onBulkMessageToggle\?\.\(message\)/);
assert.match(list, /props\.bulkMode && bodyMessages\.length === 0/);
assert.match(css, /\.assistant-turn-cluster \.msg-actions\s*\{/);
assert.doesNotMatch(header, /主窗 \/ 后台|sideUnread|onToggleChannel/);
assert.doesNotMatch(pane, /sideQuote|sideChannel|引原文|副窗只读/);
assert.doesNotMatch(bubble, /onQuoteToMain|sideSourceLabel/);
assert.doesNotMatch(app, /loadChannel\('side'\)|sideUnread/);
const deployInterrupted = {
  content: 'claude 返回了错误',
  meta: JSON.stringify({ interruptionReason: 'deploy-restart' }),
};
assert.equal(interruptionReason(deployInterrupted), 'deploy-restart');
assert.equal(displayedErrorContent(deployInterrupted), '部署重启中断');
assert.equal(displayedErrorContent({
  ...deployInterrupted,
  meta: JSON.stringify({ interruptionReason: 'deploy-restart', resumeQueued: true }),
}), '部署重启中断，已排队续跑');
assert.equal(
  displayedErrorContent({ content: '原有兜底错误', meta: JSON.stringify({ interruptionReason: 'claude-error' }) }),
  '原有兜底错误',
);
assert.equal(fs.existsSync(path.join(root, 'src/sideChannel.ts')), false);
assert.equal(fs.existsSync(path.join(root, 'src/sideQuote.ts')), false);

console.log('message time and unread presentation checks passed');
