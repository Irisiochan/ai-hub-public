import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  buildFfmpegArgs,
  cameraCapabilities,
  captureFrame,
  handleSnapRequest,
} from './camera.mjs';

test('buildFfmpegArgs produces the exact dshow one-frame pipe command', () => {
  assert.deepEqual(buildFfmpegArgs('Logitech BRIO'), [
    '-hide_banner', '-loglevel', 'error', '-f', 'dshow', '-i', 'video=Logitech BRIO',
    '-frames:v', '1', '-q:v', '5', '-f', 'mjpeg', 'pipe:1',
  ]);
});

test('captureFrame pins spawn to shell:false and buffers stdout only', async () => {
  let observed;
  const fakeSpawn = (command, args, options) => {
    observed = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      child.emit('close', 0);
    });
    return child;
  };
  const frame = await captureFrame(
    { cameraDevice: 'Camera', ffmpegCommand: 'C:/ffmpeg/bin/ffmpeg.exe' },
    { spawn: fakeSpawn },
  );
  assert.deepEqual(frame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.equal(observed.command, 'C:/ffmpeg/bin/ffmpeg.exe');
  assert.equal(observed.options.shell, false);
  assert.equal(observed.options.windowsHide, true);
  assert.deepEqual(observed.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('allowCamera false advertises no capability and refuses a smuggled request', async () => {
  const cfg = { allowCamera: false, cameraDevice: 'Camera' };
  assert.deepEqual(cameraCapabilities(cfg), {});
  let captured = false;
  let posted = false;
  const handled = await handleSnapRequest(
    cfg,
    { id: 'server-controlled-id', timeoutMs: 20_000 },
    async () => { posted = true; },
    async () => { captured = true; return Buffer.from([0xff, 0xd8]); },
  );
  assert.equal(handled, false);
  assert.equal(captured, false, 'server snapRequest must not override local allowCamera');
  assert.equal(posted, false);
});

test('enabled camera uploads either JPEG data or a bounded error', async () => {
  const posts = [];
  const cfg = { allowCamera: true, cameraDevice: 'Camera' };
  assert.deepEqual(cameraCapabilities(cfg), { camera: true });
  assert.equal(await handleSnapRequest(
    cfg,
    { id: 'ok' },
    async (id, payload) => posts.push({ id, payload }),
    async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  ), true);
  assert.equal(posts[0].id, 'ok');
  assert.equal(posts[0].payload.imageBase64, '/9j/2Q==');
});
