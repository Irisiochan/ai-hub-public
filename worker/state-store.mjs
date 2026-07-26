import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const VERSION = 2;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 5_000;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(sleepArray, 0, 0, ms);
}

function readJson(file, fallback = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function normalize(raw) {
  const legacyActive = raw.active && typeof raw.active === 'object' ? raw.active : null;
  const jobs = raw.jobs && typeof raw.jobs === 'object' && !Array.isArray(raw.jobs)
    ? raw.jobs
    : legacyActive?.job?.id ? { [legacyActive.job.id]: legacyActive } : {};
  return {
    ...raw,
    version: VERSION,
    launcher: raw.launcher && typeof raw.launcher === 'object' ? raw.launcher : null,
    jobs,
    events: Array.isArray(raw.events) ? raw.events : [],
  };
}

function acquireLock(file) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const handle = fs.openSync(lock, 'wx');
      fs.writeFileSync(handle, JSON.stringify({ pid: process.pid, at: Date.now() }));
      return { lock, handle };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {}
      sleepSync(20);
    }
  }
  throw new Error(`timed out waiting for state lock: ${lock}`);
}

function releaseLock(lease) {
  try { fs.closeSync(lease.handle); } catch {}
  try { fs.unlinkSync(lease.lock); } catch {}
}

export function loadState(file) {
  return normalize(readJson(file));
}

export function updateState(file, updater) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lease = acquireLock(file);
  try {
    const current = loadState(file);
    const next = normalize(updater(current) ?? current);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return next;
  } finally {
    releaseLock(lease);
  }
}

export function saveWorkerSpool(file, spool) {
  return updateState(file, (current) => ({
    ...current,
    jobs: spool.jobs,
    events: spool.events,
  }));
}

export function saveLauncherState(file, launcher) {
  return updateState(file, (current) => ({ ...current, launcher }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [command, file, encoded] = process.argv.slice(2);
  if (command !== 'patch-launcher' || !file || !encoded) {
    console.error('usage: node state-store.mjs patch-launcher <state-file> <base64-json>');
    process.exit(2);
  }
  const launcher = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  saveLauncherState(path.resolve(file), launcher);
}
