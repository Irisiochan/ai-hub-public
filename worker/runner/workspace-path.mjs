import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/**
 * VPS development migration (G01): platform-aware workspace path helpers.
 *
 * Windows and POSIX must NOT share one normalization:
 * - Windows: case-insensitive (compare lower-cased), win32 separators.
 * - Linux/POSIX: case-sensitive (never lower-case), posix separators.
 *
 * A Windows absolute path must never be "converted" into a VPS path by
 * string rewriting; each platform only accepts its own absolute form.
 */

export function isWindowsAbsolute(value) {
  const text = String(value ?? '').trim();
  return /^[A-Za-z]:[\\/]/.test(text) || /^\\\\[^\\]+\\[^\\/]+/.test(text);
}

export function isPosixAbsolute(value) {
  const text = String(value ?? '').trim();
  return !isWindowsAbsolute(text) && text.startsWith('/');
}

export function platformOf(value) {
  const text = String(value ?? '').trim();
  if (isWindowsAbsolute(text)) return 'win32';
  if (isPosixAbsolute(text)) return 'posix';
  return 'unknown';
}

export function normalizeWorkspacePath(value, platform = process.platform) {
  const text = String(value ?? '').trim();
  // Classify by string form, never by host: a POSIX path examined on a
  // Windows dev machine must stay POSIX (and vice versa).
  if (isWindowsAbsolute(text)) return path.win32.normalize(text);
  if (isPosixAbsolute(text)) return path.posix.normalize(text);
  if (platform === 'win32') return path.win32.normalize(text);
  return path.posix.normalize(text);
}

/** Comparison key: Windows paths fold case, POSIX paths preserve it. */
export function workspaceKey(value, platform = process.platform) {
  void platform;
  const normalized = normalizeWorkspacePath(value, platform);
  return isWindowsAbsolute(normalized) ? normalized.toLowerCase() : normalized;
}

/**
 * True when `target` is inside (or equal to) `root` on the given platform.
 * Cross-platform pairs (win32 target vs posix root) never match.
 */
export function workspaceContains(root, target, platform = process.platform) {
  const rootText = String(root ?? '').trim();
  const targetText = String(target ?? '').trim();
  // Classify by string form so POSIX pairs behave identically on any host.
  const rootIsWindows = isWindowsAbsolute(rootText);
  const targetIsWindows = isWindowsAbsolute(targetText);
  if (rootIsWindows !== targetIsWindows) return false;
  if (!rootIsWindows && (!isPosixAbsolute(rootText) || !isPosixAbsolute(targetText))) return false;
  const sep = rootIsWindows ? path.win32.sep : path.posix.sep;
  const norm = (v) => (rootIsWindows ? path.win32.normalize(v) : path.posix.normalize(v));
  const comparable = (v) => (rootIsWindows ? norm(v).toLowerCase() : norm(v));
  const base = comparable(rootText);
  const candidate = comparable(targetText);
  void platform;
  return candidate === base || candidate.startsWith(base + sep);
}

/**
 * Resolve a job workspace against an allowlist root and verify the real
 * path (symlinks resolved) stays inside the real root. Returns the resolved
 * absolute target. Throws on cross-platform input, missing paths, or
 * realpath escape.
 */
export function resolveWorkspaceTarget(root, target, { realpath = fs.realpathSync } = {}) {
  const rootText = String(root ?? '');
  const targetText = String(target ?? '');
  if (platformOf(rootText) === 'unknown' || platformOf(targetText) === 'unknown') {
    throw new Error('workspace and root must both be absolute paths');
  }
  if (!workspaceContains(rootText, targetText)) {
    throw new Error(`workspace is outside allowlist: ${targetText}`);
  }
  const realRoot = realpath(rootText);
  const realTarget = realpath(targetText);
  if (!workspaceContains(realRoot, realTarget)) {
    throw new Error(`workspace realpath escapes allowlist root: ${targetText}`);
  }
  return realTarget;
}

/** Assert an absolute state file path resolved against the config dir. */
export function resolveStateFile(configPath, stateFile) {
  const raw = String(stateFile ?? 'worker-state.json');
  // Absolute forms stay on their own platform so a VPS config authored on a
  // Windows machine keeps its POSIX path (and vice versa).
  if (isWindowsAbsolute(raw)) return path.win32.normalize(raw);
  if (isPosixAbsolute(raw)) return path.posix.normalize(raw);
  const base = path.resolve(path.dirname(path.resolve(configPath)), raw);
  if (!path.isAbsolute(base)) throw new Error(`stateFile must resolve to an absolute path: ${stateFile}`);
  return base;
}
