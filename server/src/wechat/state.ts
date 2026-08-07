import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WechatStickyTarget } from './routing.js';

export interface WechatChannelState {
  cursor: string;
  sticky: WechatStickyTarget | null;
}

const EMPTY_STATE: WechatChannelState = { cursor: '', sticky: null };

export function loadWechatChannelState(file: string): WechatChannelState {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WechatChannelState>;
    const sticky = parsed.sticky;
    return {
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
      sticky:
        sticky && ['claude', 'codex', 'aye'].includes(sticky.targetId) && Number.isFinite(sticky.touchedAt)
          ? sticky
          : null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...EMPTY_STATE };
    throw error;
  }
}

export function saveWechatChannelState(file: string, state: WechatChannelState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    try { fs.chmodSync(file, 0o600); } catch {}
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
