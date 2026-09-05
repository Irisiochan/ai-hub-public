import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { filterModelOptions, visibleModelOptions } from '../src/modelSearch.ts';

const root = path.resolve(import.meta.dirname, '..');
const picker = fs.readFileSync(path.join(root, 'src/components/ModelPicker.tsx'), 'utf8');
const drawer = fs.readFileSync(path.join(root, 'src/components/chat/RuntimeDrawer.tsx'), 'utf8');
const apiFields = fs.readFileSync(path.join(root, 'src/components/contact-config/ApiFields.tsx'), 'utf8');

assert.match(picker, /aria-label="搜索模型"/);
assert.match(picker, /role="listbox"/);
assert.match(picker, /使用 \{customId\}/);
assert.match(drawer, /contact\.backend === 'api'/);
assert.match(drawer, /<ModelPicker/);
assert.match(apiFields, /<ModelPicker/);
assert.match(apiFields, /allowCustom/);

const models = [
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'deepseek-chat', label: 'DeepSeek Chat' },
];
assert.deepEqual(
  filterModelOptions(models, 'flash').map((model) => model.id),
  ['gemini-3.5-flash'],
);
assert.deepEqual(
  filterModelOptions(models, 'gemini pro').map((model) => model.id),
  ['gemini-2.5-pro'],
);
assert.equal(visibleModelOptions(models, '').total, 3);
assert.equal(visibleModelOptions(Array.from({ length: 120 }, (_, i) => ({ id: `m-${i}`, label: `m-${i}` })), '').hidden, 40);

console.log('model picker search checks passed');
