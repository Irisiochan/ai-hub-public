import { contactConfig, openContact } from './configSchemas.js';
import { z } from 'zod';
import { defineGatewayTool, type GatewayTool } from './gatewayTool.js';
import type { ContactRow, Db, WorkerRow } from '../db.js';
import type { CameraSnapBroker } from '../workers/cameraSnap.js';
import type { CompanionHeartbeat } from './companionHeartbeat.js';

export const HEARTBEAT_GUIDANCE = `
心跳协议：只有 User 在运行时面板开启心跳窗口后，camera_snap 才可用。心跳自动唤醒不是 User 的手动发言；可按当轮提示自主拍一帧，画面会直接出现在 camera_snap 工具结果里。画面只属于当轮，不保存、不引用、不创建附件。获取不到画面就作罢（回 HEARTBEAT_OK 或如实说明），不要尝试用其他工具或命令获取画面。心跳轮说不说话由你自己判断，不设门槛，主动说话不算打扰；决定沉默时整条回复只写 HEARTBEAT_OK，不要附加解释。例外：一旦收藏了商品，必须开口告诉她收藏了什么、为什么，不能只回 HEARTBEAT_OK。心跳轮里看摄像头、逛淘宝（若 taobao_* 工具在列表里）、两样都做或都不做，每一轮都由你自己决定。平时不要主动提心跳机制，除非 User 先问。
`.trim();

const CAMERA_FAILURE_SUFFIX = '获取不到画面就作罢（回 HEARTBEAT_OK 或如实说明），不要尝试用其他工具或命令获取画面。';

function cameraFailure(text: string): { ok: false; text: string } {
  return { ok: false, text: `${text}\n${CAMERA_FAILURE_SUFFIX}` };
}

function cameraWorkerOnline(db: Db): boolean {
  const rows = db.prepare(
    `SELECT * FROM workers
     WHERE last_seen_at IS NOT NULL AND datetime(last_seen_at) >= datetime('now', '-70 seconds')`
  ).all() as WorkerRow[];
  return rows.some((row) => {
    try {
      return JSON.parse(row.capabilities || '{}').camera === true;
    } catch {
      return false;
    }
  });
}

export function buildCameraTool(
  broker: CameraSnapBroker,
  heartbeat: CompanionHeartbeat,
  db: Db,
  contactId: string,
): GatewayTool {
  return defineGatewayTool({
    name: 'camera_snap',
    description: '在已开启的心跳窗口内，请 PC Worker 从本地摄像头抓拍一帧，并把画面直接附在当轮工具结果中。',
    inputSchema: { reason: z.string().optional() },
    exec: async () => {
      const row = db.prepare("SELECT * FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'")
        .get(contactId) as ContactRow | undefined;
      if (!row || contactConfig(openContact(row)).heartbeat?.enabled !== true) {
        return cameraFailure('这个联系人没有开启心跳摄像头权限。');
      }
      if (!heartbeat.isActive(contactId)) {
        return cameraFailure('心跳窗口未激活，摄像头不可用。让 User 在运行时面板开启心跳后再试。');
      }
      if (!cameraWorkerOnline(db)) {
        return cameraFailure('当前没有在线且允许摄像头的 PC Worker。');
      }
      const result = await broker.request(contactId);
      if (!result.ok || !result.jpegBase64) return cameraFailure(result.text);
      return {
        ok: true,
        text: '已拍摄一帧，画面已直接附在本条工具结果里，仅本轮有效、未存盘。看完自然回应或回 HEARTBEAT_OK 即可。',
        image: { data: result.jpegBase64, mimeType: 'image/jpeg' },
      };
    },
  });
}
