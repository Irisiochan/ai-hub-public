import crypto from 'node:crypto';
import type { HubLogger } from '../logger.js';

export interface CameraSnapResult {
  ok: boolean;
  text: string;
  jpegBase64?: string;
}

interface PendingSnap {
  id: string;
  createdAt: number;
  timeoutMs: number;
  claimed: boolean;
  timer: NodeJS.Timeout;
  resolve(result: CameraSnapResult): void;
}

const CLAIM_TIMEOUT_MS = 20_000;

export class CameraSnapBroker {
  private pending: PendingSnap | null = null;

  constructor(private readonly logger?: HubLogger) {}

  request(_contactId: string, timeoutMs = 25_000): Promise<CameraSnapResult> {
    if (this.pending) {
      return Promise.resolve({ ok: false, text: '摄像头正忙，上一帧还没有返回，请稍后再试。' });
    }
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.id !== id) return;
        this.pending = null;
        resolve({
          ok: false,
          text: `摄像头 ${Math.round(timeoutMs / 1000)} 秒内没有返回画面（PC 离线 / ffmpeg 失败？）`,
        });
      }, timeoutMs);
      timer.unref();
      this.pending = { id, createdAt: Date.now(), timeoutMs, claimed: false, timer, resolve };
    });
  }

  takePending(caps: { camera?: boolean }): { id: string; timeoutMs: number } | null {
    if (caps.camera !== true || !this.pending || this.pending.claimed) return null;
    this.pending.claimed = true;
    return { id: this.pending.id, timeoutMs: Math.min(this.pending.timeoutMs, CLAIM_TIMEOUT_MS) };
  }

  fulfill(requestId: string, jpegBuffer: Buffer): boolean {
    const pending = this.pending;
    if (!pending || pending.id !== requestId) return false;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve({
      ok: true,
      text: '摄像头画面已返回。',
      jpegBase64: jpegBuffer.toString('base64'),
    });
    this.logger?.info({
      component: 'camera-snap',
      requestId,
      bytes: jpegBuffer.length,
      elapsedMs: Date.now() - pending.createdAt,
    }, 'camera frame fulfilled');
    return true;
  }

  fail(requestId: string, reason: string): boolean {
    const pending = this.pending;
    if (!pending || pending.id !== requestId) return false;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.resolve({ ok: false, text: `摄像头抓拍失败：${reason.slice(0, 1000)}` });
    return true;
  }

}
