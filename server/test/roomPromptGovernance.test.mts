// O7: prompt text follows room governance (open drops the strict rituals).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { roomTurnNotice } from '../src/rooms/roomPrompt.js';
import { roomTaskGuidance } from '../src/roomTasks/roomTaskTools.js';

test('O7: strict guidance keeps the handoff ritual text', () => {
  const text = roomTaskGuidance();
  assert.match(text, /task_accept/);
  assert.match(text, /交接义务/);
  assert.doesNotMatch(text, /task_pass/);
});

test('O7: open guidance uses task_pass without accept/obligation/nonce', () => {
  const text = roomTaskGuidance('open');
  assert.match(text, /task_pass/);
  assert.match(text, /auto-pass/);
  assert.match(text, /唤醒预算/);
  assert.doesNotMatch(text, /task_accept/);
  assert.doesNotMatch(text, /交接义务/);
  assert.doesNotMatch(text, /nonce/);
});

test('O7: strict turn notice keeps obligation and accept paragraphs', () => {
  const text = roomTurnNotice('normal', [], undefined, undefined, 'codex');
  assert.match(text, /task_accept/);
  assert.match(text, /交接义务/);
});

test('O7: open turn notice uses the pass-based paragraphs', () => {
  const text = roomTurnNotice('normal', [], undefined, undefined, 'codex', 'codex', false, undefined, 'open');
  assert.match(text, /task_pass/);
  assert.match(text, /auto-pass/);
  assert.doesNotMatch(text, /task_accept/);
  assert.doesNotMatch(text, /未交接失败/);
  // Non-task rails stay identical across modes.
  assert.match(text, /ROOM_TURN_GATEWAY/);
  assert.match(text, /跨室任务不可读不可写/);
});
