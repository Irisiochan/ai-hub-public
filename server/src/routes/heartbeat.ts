import { Router } from 'express';
import { HeartbeatError, type CompanionHeartbeat } from '../agents/companionHeartbeat.js';
import type { Db } from '../db.js';

export function heartbeatRouter(db: Db, heartbeat: CompanionHeartbeat): Router {
  const r = Router();

  const exists = (contactId: string): boolean => Boolean(db.prepare(
    "SELECT id FROM contacts WHERE id = ? AND enabled = 1 AND kind = 'dm'"
  ).get(contactId));

  r.get('/:id/heartbeat', (req, res) => {
    if (!exists(req.params.id)) return res.status(404).json({ error: 'contact not found' });
    res.json(heartbeat.status(req.params.id));
  });

  r.post('/:id/heartbeat', (req, res) => {
    if (!exists(req.params.id)) return res.status(404).json({ error: 'contact not found' });
    try {
      if (req.body?.intervalMinutes !== undefined) {
        throw new HeartbeatError('intervalMinutes 已停用；每次心跳会在 4 到 7 分钟间重新随机');
      }
      if (req.body?.unlimited !== undefined && req.body.unlimited !== true) {
        throw new HeartbeatError('unlimited 只能设为 true');
      }
      if (req.body?.unlimited === true && req.body?.minutes !== undefined) {
        throw new HeartbeatError('不限时心跳不能同时设置 minutes');
      }
      const status = heartbeat.startSession(
        req.params.id,
        req.body?.unlimited === true ? null : Number(req.body?.minutes),
      );
      res.status(201).json(status);
    } catch (error) {
      if (error instanceof HeartbeatError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  });

  r.delete('/:id/heartbeat', (req, res) => {
    if (!exists(req.params.id)) return res.status(404).json({ error: 'contact not found' });
    const status = heartbeat.status(req.params.id);
    if (!status.active) return res.status(404).json({ error: 'heartbeat session not active' });
    res.json(heartbeat.stopSession(req.params.id, 'manual'));
  });

  return r;
}
