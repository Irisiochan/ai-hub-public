import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
  OpencodeCliBackend,
  opencodeFileArgs,
  opencodeImageMimeType,
  parseOpencodeModelList,
  prettyOpencodeModelLabel,
} from '../src/agents/opencodeCli.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const mockCliPath = path.join(here, 'mock-opencode.mjs');

const models = await OpencodeCliBackend.listModels({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  log: () => {},
});
assert.deepEqual(
  models.map(({ id }) => id),
  [
    'opencode-go/muse-spark-1.2-contributor',
    'opencode-go/muse-spark-1.2',
    'anthropic/claude-sonnet-4-6',
    'openai/gpt-5',
  ],
  'opencode models 必须返回当前账号可见的全部模型'
);
assert.equal(
  prettyOpencodeModelLabel('opencode-go/muse-spark-1.2-contributor'),
  'Muse Spark 1.2 Contributor (Go)'
);
assert.deepEqual(
  parseOpencodeModelList('Usage: opencode models\nopencode-go/foo\n# skip\nnot-a-model\n').map((model) => model.id),
  ['opencode-go/foo'],
  'opencode models 解析必须丢掉说明行，只保留 provider/model'
);

async function turn(backend: OpencodeCliBackend, text: string) {
  const events = [];
  for await (const event of backend.sendTurn({ text }).events) events.push(event);
  return events;
}

const hello = new OpencodeCliBackend({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  model: 'opencode-go/muse-spark-1.2-contributor',
  turnTimeoutMs: 5000,
  log: () => {},
});
await hello.start(null);
const first = await turn(hello, 'hello');
const done = first.find((event) => event.type === 'done');
assert.equal(done?.type, 'done');
if (done?.type === 'done') assert.equal(done.finalText, '缪斯在。');
assert(first.some((event) => event.type === 'session' && event.sessionId === 'ses_mock_new'));
await hello.stop();

const resumed = new OpencodeCliBackend({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  turnTimeoutMs: 5000,
  log: () => {},
});
await resumed.start('ses_existing');
const think = await turn(resumed, 'think');
assert(think.some((event) => event.type === 'thinking' && event.text.includes('想一下')));
assert(think.some((event) => event.type === 'done' && event.finalText === '想完了。'));
await resumed.stop();

const failing = new OpencodeCliBackend({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  turnTimeoutMs: 5000,
  log: () => {},
});
await failing.start(null);
const failed = await turn(failing, 'fail');
assert(failed.some((event) => event.type === 'error' && event.message.includes('catalog 401')));
assert(!failed.some((event) => event.type === 'done'));
await failing.stop();

const flagCli = new OpencodeCliBackend({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  model: 'opencode-go/muse-spark-1.2-contributor',
  variant: 'xhigh',
  turnTimeoutMs: 5000,
  log: () => {},
});
await flagCli.start('ses_keep');
const flags = await turn(flagCli, 'flags');
const flagDone = flags.find((event) => event.type === 'done');
assert.equal(flagDone?.type, 'done');
const argv = JSON.parse(flagDone && flagDone.type === 'done' ? flagDone.finalText : '[]') as string[];
assert(argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json');
assert(argv.includes('--pure'));
assert(argv.includes('--thinking'));
assert.equal(argv[argv.indexOf('-m') + 1], 'opencode-go/muse-spark-1.2-contributor');
assert.equal(argv[argv.indexOf('--variant') + 1], 'xhigh');
assert.equal(argv[argv.indexOf('--session') + 1], 'ses_keep');
assert.equal(argv[argv.indexOf('--') + 1], 'flags');
await flagCli.stop();

const png = path.join(here, 'dm.png');
const jpeg = path.join(here, 'shot.jpeg');
assert.equal(opencodeImageMimeType(png), 'image/png');
assert.equal(opencodeImageMimeType(jpeg), 'image/jpeg');
assert.deepEqual(opencodeFileArgs([png, jpeg]), ['--file', png, '--file', jpeg]);
assert.throws(() => opencodeFileArgs([path.join(here, 'notes.bmp')]), /不支持这个图片格式/);

const imageCli2 = new OpencodeCliBackend({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  turnTimeoutMs: 5000,
  log: () => {},
});
await imageCli2.start(null);
const withFiles = [];
for await (const event of imageCli2.sendTurn({ text: 'flags', imagePaths: [png, jpeg] }).events) {
  withFiles.push(event);
}
await imageCli2.stop();
const withFilesDone = withFiles.find((event) => event.type === 'done');
assert.equal(withFilesDone?.type, 'done');
const fileArgv = JSON.parse(withFilesDone && withFilesDone.type === 'done' ? withFilesDone.finalText : '[]') as string[];
const firstFile = fileArgv.indexOf('--file');
assert.equal(fileArgv[firstFile], '--file');
assert.equal(fileArgv[firstFile + 1], png);
assert.equal(fileArgv[firstFile + 2], '--file');
assert.equal(fileArgv[firstFile + 3], jpeg);
const dashAt = fileArgv.indexOf('--');
assert(firstFile >= 0 && dashAt > firstFile + 3, '--file 必须出现在 -- 之前，否则会被当成 prompt');
assert.equal(fileArgv[dashAt + 1], 'flags');
assert(!fileArgv.some((arg) => arg.startsWith('data:image/')), '不得把图片 base64 塞进 argv');

const badImage = new OpencodeCliBackend({
  cliPath: mockCliPath,
  cwd: process.cwd(),
  turnTimeoutMs: 5000,
  log: () => {},
});
await badImage.start(null);
const badEvents = [];
for await (const event of badImage.sendTurn({
  text: 'flags',
  imagePaths: [path.join(here, 'notes.bmp')],
}).events) {
  badEvents.push(event);
}
await badImage.stop();
assert(
  badEvents.some((event) => event.type === 'error' && event.message.includes('opencode 图片读取失败')),
  '未知扩展名不得 spawn，应直接报非致命错误'
);
assert(!badEvents.some((event) => event.type === 'done'), '格式错误不能伪装成成功');

function spawnMock(closeStdin: boolean): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [mockCliPath, 'run', '--format', 'json', '--', 'hello'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    if (closeStdin) child.stdin.end();
    child.on('exit', (code) => resolve({ code, stderr }));
  });
}

const closedStdin = await spawnMock(true);
assert.equal(closedStdin.code, 0);

const openStdin = await spawnMock(false);
assert.equal(openStdin.code, 3);
assert(openStdin.stderr.includes('stdin was not closed'));

console.log('opencode cli smoke passed');
