import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  getUiPreferenceSnapshot,
  initializeUiPreferences,
  resolveMotionLevel,
  setMotionLevel,
  setSoundCueEnabled,
  setSoundVolume,
} from '../src/preferences/store.ts';
import { playSoundEvent, previewSounds, soundTiming } from '../src/sound.ts';

assert.equal(resolveMotionLevel(null, false, 'full'), 'full');
assert.equal(resolveMotionLevel(null, true, 'full'), 'reduced');
assert.equal(resolveMotionLevel('full', true, 'reduced'), 'full', 'explicit user choice overrides system and theme');
assert.equal(resolveMotionLevel('off', false, 'full'), 'off');

assert.ok(soundTiming.maxCueMilliseconds <= 250, `longest cue is ${soundTiming.maxCueMilliseconds}ms`);
assert.ok(soundTiming.sendThrottleMilliseconds >= 300);
assert.ok(soundTiming.sendRelativeGain <= 0.5);

const stored = new Map();
globalThis.localStorage = {
  getItem: (key) => stored.get(key) ?? null,
  setItem: (key, value) => stored.set(key, String(value)),
  removeItem: (key) => stored.delete(key),
  clear: () => stored.clear(),
  key: (index) => [...stored.keys()][index] ?? null,
  get length() { return stored.size; },
};
initializeUiPreferences();
setMotionLevel('full');
setSoundVolume(0.55);
setSoundCueEnabled('worker', false);
setSoundCueEnabled('worker', true);
assert.equal(stored.get('ai-hub.motion.level.v1'), 'full');
assert.equal(JSON.parse(stored.get('ai-hub.sound.settings.v1')).volume, 0.55);
assert.equal(getUiPreferenceSnapshot().sound.cues.worker, true);
let oscillatorStarts = 0;
class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  async resume() { this.state = 'running'; }
  createOscillator() {
    return {
      type: 'sine',
      frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
      start() { oscillatorStarts += 1; },
      stop() {},
    };
  }
  createGain() {
    return {
      gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
      connect() {},
    };
  }
}
globalThis.window = { AudioContext: FakeAudioContext, setTimeout };
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { locks: { request: async (_name, _options, callback) => callback({ name: _name }) } },
});

assert.equal(await previewSounds(), true);
await new Promise((resolve) => setTimeout(resolve, 1050));
assert.equal(oscillatorStarts, 6, 'preview synthesizes all four distinct cue envelopes');

const contexts = {
  currentForeground: { currentConversation: true, pageVisible: true },
  otherForeground: { currentConversation: false, pageVisible: true },
  background: { currentConversation: true, pageVisible: false },
};
const playbackRecord = [];
for (const [contextName, contextValue] of Object.entries(contexts)) {
  for (const cue of ['send', 'assistant', 'worker', 'error']) {
    if (cue === 'send') await new Promise((resolve) => setTimeout(resolve, 305));
    const played = await playSoundEvent(cue, `matrix:${contextName}:${cue}`, contextValue);
    playbackRecord.push({ context: contextName, cue, played });
    assert.equal(played, true, `${cue} must play once in ${contextName}`);
  }
}
assert.equal(await playSoundEvent('assistant', 'matrix:background:assistant', contexts.background), false, 'duplicate event stays silent');
await new Promise((resolve) => setTimeout(resolve, 305));
assert.equal(await playSoundEvent('send', 'throttle:first', contexts.currentForeground), true);
assert.equal(await playSoundEvent('send', 'throttle:second', contexts.currentForeground), false, 'send cue is throttled');

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const app = read('src/App.tsx');
const pane = read('src/components/ChatPane.tsx');
const list = read('src/components/chat/MessageList.tsx');
const sound = read('src/sound.ts');
const motion = read('src/styles/motion.css');
const settings = read('src/components/MotionSoundSettings.tsx');

assert.match(app, /onDelta: \(delta\) => deltaBatcher\.add\(delta\)/);
assert.doesNotMatch(app.match(/onDelta:[^\n]+/)?.[0] ?? '', /playSoundEvent|motion/i);
assert.match(app, /msg\.role === 'assistant' && msg\.kind === 'text' && msg\.status === 'done'/);
assert.match(app, /msg\.turn_id \?\? String\(msg\.id\)/, 'assistant completion is deduped per turn');
assert.match(app, /job\.status === 'done'/);
assert.match(app, /liveEventsReadyRef\.current/);
assert.match(pane, /send:\$\{attempt\.idempotencyKey\}:accepted/);
assert.match(list, /knownMessageIdsRef/);
assert.match(list, /processOpen && \(/, 'process animation must remain behind a user-controlled disclosure');
assert.match(sound, /document\.visibilityState|pageVisible/);
assert.match(sound, /navigator\.locks/);
assert.match(sound, /RECENT_EVENTS_KEY/);
assert.match(motion, /--motion-enter:\s*300ms/);
assert.match(motion, /--motion-exit:\s*250ms/);
assert.match(motion, /--motion-ease:\s*cubic-bezier\(\.4, 0, \.2, 1\)/);
assert.match(motion, /chat-pane\[data-motion-state='enter'\]/);
assert.match(motion, /chat-pane\[data-motion-state='exit'\]/);
assert.match(motion, /data-motion-level='off'/);
assert.match(motion, /data-motion-level='reduced'/);
assert.match(motion, /transition-property:\s*opacity/);
for (const label of ['动画等级', '声音总开关', '发送', '回复完成', 'Worker 完成', '错误', '音量', '试听']) {
  assert.match(settings, new RegExp(label));
}

console.log(JSON.stringify({
  motion: { levels: ['off', 'reduced', 'full'], explicitOverride: true },
  sound: soundTiming,
  deltaPath: { classToggle: false, sound: false },
  playbackRecord,
}));

delete globalThis.localStorage;
delete globalThis.window;
delete globalThis.navigator;
