import type { JobRow } from '../db.js';

export type HumanDeliveryState =
  | 'in_progress'
  | 'completed_not_delivered'
  | 'delivered_waiting_deploy'
  | 'online_waiting_validation'
  | 'closed_loop'
  | 'user_decision'
  | 'rework_required'
  | 'failure_or_blocked';

export interface DeliverySummary {
  state: HumanDeliveryState;
  label: string;
  summary: string;
  nextOwner: string;
  needsUserDecision: boolean;
}

type JsonRecord = Record<string, unknown>;

const ACTIVE = new Set([
  'pending', 'claimed', 'running', 'recovering', 'pause_requested', 'cancel_requested',
]);

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function parse(raw: string | null | undefined): JsonRecord {
  try { return raw ? record(JSON.parse(raw)) : {}; } catch { return {}; }
}

function bool(...values: unknown[]): boolean {
  return values.some((value) => value === true);
}

function text(...values: unknown[]): string {
  const found = values.find((value) => typeof value === 'string' && value.trim());
  return typeof found === 'string' ? found.trim() : '';
}

function declared(meta: JsonRecord): JsonRecord {
  return record(meta.declared);
}

function normalizedStage(meta: JsonRecord): string {
  const declaration = declared(meta);
  return text(
    declaration.stage,
    declaration.lifecycleStage,
    meta.stage,
    meta.lifecycleStage,
    meta.humanStatus,
  ).toLowerCase().replace(/-/g, '_');
}

function summary(
  state: HumanDeliveryState,
  label: string,
  fallback: string,
  nextOwner: string,
  needsUserDecision = false,
  custom = '',
): DeliverySummary {
  return {
    state,
    label,
    summary: custom || fallback,
    nextOwner,
    needsUserDecision,
  };
}

/** Convert runner/git evidence into the one human-facing delivery conclusion. */
export function deriveDeliverySummary(row: Pick<
  JobRow,
  'status' | 'delivery_state' | 'delivery_meta' | 'permissions' | 'result' | 'error'
>): DeliverySummary {
  const meta = parse(row.delivery_meta);
  const declaration = declared(meta);
  const permissions = parse(row.permissions);
  const stage = normalizedStage(meta);
  const custom = text(declaration.summary, meta.summary);
  const declaredOwner = text(declaration.nextOwner, declaration.next_owner, meta.nextOwner, meta.next_owner);

  if (ACTIVE.has(row.status)) {
    return summary('in_progress', '正在执行', '任务正在执行，完成后会自动更新交付结论。', declaredOwner || 'PC Worker');
  }

  if (
    stage === 'user_decision'
    || bool(declaration.needsUserDecision, declaration.needs_user_decision, meta.needsUserDecision)
    || text(declaration.blocker, meta.blocker) === 'awaiting_exact_target_approval'
  ) {
    return summary(
      'user_decision',
      '需要你决定',
      '执行已停在需要明确授权或产品选择的位置。',
      declaredOwner || 'User',
      true,
      custom,
    );
  }

  if (stage === 'online_waiting_validation') {
    return summary(
      'online_waiting_validation',
      '已上线，等待验收',
      '变更已经上线，正在等待或执行线上验收。',
      declaredOwner || '验收负责人',
      false,
      custom,
    );
  }

  if (stage === 'closed_loop') {
    return summary(
      'closed_loop',
      '已闭环',
      '实现、交付和要求内的验收都已完成。',
      declaredOwner || '无需后续动作',
      false,
      custom,
    );
  }

  if (stage === 'delivered_waiting_deploy') {
    return summary(
      'delivered_waiting_deploy',
      '已交付，等待部署',
      '代码已经交付，下一步是部署并完成线上验收。',
      declaredOwner || '部署负责人',
      false,
      custom,
    );
  }

  if (stage === 'rework_required') {
    return summary(
      'rework_required',
      '需要返工',
      '当前交付结论已被打回，需要按反馈继续处理。',
      declaredOwner || 'PC Worker',
      false,
      custom,
    );
  }

  if (
    ['failed', 'interrupted', 'cancelled', 'expired'].includes(row.status)
    || ['failed_clean', 'unknown'].includes(row.delivery_state ?? '')
  ) {
    return summary(
      'failure_or_blocked',
      '失败或受阻',
      '任务未形成可验收交付，需要先处理失败或阻塞原因。',
      declaredOwner || '任务负责人',
      false,
      custom,
    );
  }

  if (
    row.status === 'blocked'
    || ['blocked_local_changes', 'blocked_unpushed'].includes(row.delivery_state ?? '')
  ) {
    const unpushed = row.delivery_state === 'blocked_unpushed';
    return summary(
      'completed_not_delivered',
      unpushed ? '已提交，尚未推送' : '已完成，尚未交付',
      unpushed
        ? '本地提交已经形成，但尚未推送到远端。'
        : '执行已经结束，但改动仍停留在本地，尚未形成可接收交付。',
      declaredOwner || '续接负责人',
      false,
      custom,
    );
  }

  if (row.status === 'done' && row.delivery_state === 'delivered') {
    const evidenceReadOnly = meta.changed === false
      && meta.ahead === 0
      && typeof meta.head === 'string'
      && meta.head.length > 0;
    if (permissions.write === false || evidenceReadOnly) {
      return summary(
        'closed_loop',
        '已闭环',
        permissions.write === false
          ? '只读任务已完成，结论与证据已经交付。'
          : '仓库证据确认任务未产生代码变更，结论与证据已经交付。',
        declaredOwner || '无需后续动作',
        false,
        custom,
      );
    }
    return summary(
      'delivered_waiting_deploy',
      '已交付，未收到部署证据',
      '代码已经推送，但系统尚未收到对应版本的部署完成证据。',
      declaredOwner || '部署负责人',
      false,
      custom,
    );
  }

  return summary(
    'completed_not_delivered',
    '已完成，等待交付确认',
    '执行已经结束，但交付证据还不足以确认下一阶段。',
    declaredOwner || '任务负责人',
    false,
    custom,
  );
}

/** One serializer for REST and SSE, so refresh/reconnect cannot change the conclusion. */
export function publicJob(row: JobRow) {
  const permissions = parse(row.permissions);
  const options = parse(row.options ?? '{}');
  const deliveryMeta = row.delivery_meta ? parse(row.delivery_meta) : null;
  return {
    ...row,
    permissions,
    options,
    delivery_meta: deliveryMeta,
    delivery_summary: deriveDeliverySummary(row),
  };
}
