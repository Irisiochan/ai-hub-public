import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bubble = fs.readFileSync(path.join(root, 'src/components/MessageBubble.tsx'), 'utf8');
const list = fs.readFileSync(path.join(root, 'src/components/chat/MessageList.tsx'), 'utf8');
const pane = fs.readFileSync(path.join(root, 'src/components/ChatPane.tsx'), 'utf8');
const css = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

assert.match(bubble, /const actions = \([\s\S]*className="msg-time"/);
assert.match(bubble, /title=\{formatMessageTimestamp\(message\.created_at\)\}/);
assert.match(css, /\.msg-actions\s*\{[\s\S]*?opacity:\s*0/);
assert.match(css, /\.msg-group:hover \.msg-actions,[\s\S]*\.msg-group\.selected \.msg-actions/);
assert.match(list, /className="unread-divider"[\s\S]*data-unread-divider=\{message\.id\}/);
assert.match(list, /new IntersectionObserver[\s\S]*document\.visibilityState !== 'visible'/);
assert.match(pane, /querySelector<HTMLElement>\(`\[data-unread-divider="\$\{firstUnreadId\}"\]`\)/);
assert.match(pane, /divider\.scrollIntoView\(\{ block: 'start' \}\)/);
// 主窗与副窗都把同 turn 的 tool_use 收成默认折叠条（不再仅 side）
assert.match(list, /const toolGroups = new Map/);
assert.doesNotMatch(list, /props\.channel === 'side'[\s\S]{0,80}tool_use/);
assert.match(list, /if \(message\.kind !== 'tool_use'\) return renderMessage\(message\)/);
assert.match(list, /className="side-tool-group"/);
assert.match(list, /本轮 \{group\.length\} 次工具调用/);
assert.match(css, /\.side-tool-group\s*\{/);

console.log('message time and unread presentation checks passed');
