import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const contactList = read('src/contacts/ContactList.tsx');
const header = read('src/chat/ChatHeader.tsx');
const composer = read('src/chat/Composer.tsx');
const runtime = read('src/chat/RuntimeDrawer.tsx');
const messageList = read('src/chat/MessageList.tsx');
const theme = read('src/styles/theme.css');
const tokens = read('src/styles/tokens.css');
const mobile = read('src/styles/mobile.css');
const worker = read('src/styles/worker.css');

// 958e4ed removed category tabs; type notes remain beside conversations.
assert.doesNotMatch(contactList, /className="contact-tabs"/);
for (const label of ['订阅', 'API', '群聊']) assert.ok(contactList.includes(`'${label}'`));
assert.match(contactList, /placeholder="搜索会话"/);
assert.doesNotMatch(contactList, /backend-tag/);
assert.match(header, /className="avatar chat-avatar"/);
assert.match(header, /<Icon name="runtime"/);
assert.doesNotMatch(runtime, /订阅额度/);
assert.match(runtime, /<h3>Token<\/h3>/);
assert.match(runtime, /推理强度/);
assert.match(runtime, /心跳/);
assert.match(runtime, /批量选择消息/);
assert.match(runtime, /联系人设置/);
assert.match(messageList, /const AssistantTurnCluster = memo/);
assert.match(messageList, /message\.kind === 'thinking' \|\| message\.kind === 'tool_use'/);
assert.match(tokens, /--bubble-mine:/);
assert.match(tokens, /--bubble-theirs:/);
assert.match(theme, /\.composer-shell\s*\{/);
assert.match(theme, /\.assistant-turn-cluster:has\(\.code-card, \.markdown table, \.job-thread, \.side-job-actions\)/);
assert.match(composer, /data-control-state=\{busy \? 'stop' : 'send'\}/);
assert.match(composer, /<Icon name=\{busy \? 'stop' : 'send'\}/);
assert.match(mobile, /contact-enter/);
assert.match(mobile, /contact-exit/);
assert.match(worker, /\.composer-shell\s*\{[\s\S]*width:\s*calc\(100% - 16px/);

// Literal emoji/Unicode pictograms must not be used as button artwork. Avatars
// and protocol text remain allowed outside controls.
// Components live in the feature directories (src/<feature>/*.tsx); scan all of src.
const componentsRoot = path.join(root, 'src');
const componentFiles = [];
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(target);
    else if (entry.name.endsWith('.tsx')) componentFiles.push(target);
  }
};
walk(componentsRoot);
assert.ok(componentFiles.length >= 30, `expected to scan the component files, found ${componentFiles.length}`);
const pictogram = /[\u2190-\u21ff\u2300-\u27ff]|[\p{Extended_Pictographic}]/u;
for (const file of componentFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const buttons = source.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
  for (const button of buttons) {
    assert.equal(pictogram.test(button), false, `${path.relative(root, file)} contains literal button pictogram: ${button.slice(0, 100)}`);
  }
}

console.log('Telegram shell structure and SVG control icon checks passed');
