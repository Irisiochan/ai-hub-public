import type { JobRow } from '../db.js';

type JsonRecord = Record<string, unknown>;

export interface DeliveryCheck {
  id: string;
  pass: boolean;
  detail: string;
  skipped?: boolean;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function parseRecord(raw: string | null | undefined): JsonRecord {
  try { return record(raw ? JSON.parse(raw) : {}); } catch { return {}; }
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function skipped(id: string, detail: string): DeliveryCheck {
  return { id, pass: true, skipped: true, detail: `skipped: ${detail}` };
}

/** Deterministic cross-checks over trusted job fields and independently sampled runner git data. */
export function buildDeliveryChecks(
  job: Pick<JobRow, 'permissions' | 'options'>,
  deliveryState: string | null,
  deliveryValue: unknown,
): DeliveryCheck[] {
  const delivery = record(deliveryValue);
  const declared = record(delivery.declared);
  const git = record(delivery.git);
  const before = record(delivery.before);
  const permissions = parseRecord(job.permissions);
  const options = parseRecord(job.options);
  const routeClass = typeof options.routeClass === 'string' ? options.routeClass : null;
  const write = typeof permissions.write === 'boolean' ? permissions.write : null;
  const checks: DeliveryCheck[] = [];

  if (write === null && routeClass === null) {
    checks.push(skipped('readonly-claims-write', 'permissions.write and options.routeClass are missing'));
  } else {
    const readonly = write === false || routeClass === 'recon' || routeClass === 'review';
    const claimsWrite = declared.committed === true || declared.pushed === true;
    checks.push({
      id: 'readonly-claims-write',
      pass: !(readonly && claimsWrite),
      detail: readonly && claimsWrite
        ? `read-only job claims committed=${String(declared.committed)} pushed=${String(declared.pushed)}`
        : 'no read-only write claim conflict',
    });
  }

  if (write === null) {
    checks.push(skipped('readonly-claims-deploy-stage', 'permissions.write is missing'));
  } else {
    const deployStage = declared.stage === 'delivered_waiting_deploy'
      || declared.stage === 'online_waiting_validation';
    checks.push({
      id: 'readonly-claims-deploy-stage',
      pass: !(write === false && deployStage),
      detail: write === false && deployStage
        ? `write=false job claims stage=${String(declared.stage)}`
        : 'no read-only deploy-stage conflict',
    });
  }

  if (typeof declared.pushed !== 'boolean' || !finiteNumber(git.ahead)) {
    checks.push(skipped('pushed-but-ahead', 'declared.pushed or git.ahead is missing'));
  } else {
    checks.push({
      id: 'pushed-but-ahead',
      pass: !(declared.pushed && git.ahead > 0),
      detail: declared.pushed && git.ahead > 0
        ? `declared pushed=true but git ahead=${git.ahead}`
        : `push claim agrees with git ahead=${git.ahead}`,
    });
  }

  if (
    typeof declared.committed !== 'boolean'
    || !nonEmptyString(git.head)
    || typeof git.dirty !== 'boolean'
    || !nonEmptyString(before.head)
  ) {
    checks.push(skipped('committed-but-no-new-commit', 'declared.committed, git head/dirty, or before.head is missing'));
  } else {
    const noNewCleanCommit = declared.committed === true
      && git.head === before.head
      && git.dirty === false;
    checks.push({
      id: 'committed-but-no-new-commit',
      pass: !noNewCleanCommit,
      detail: noNewCleanCommit
        ? `declared committed=true but clean HEAD stayed ${String(git.head).slice(0, 12)}`
        : 'commit claim is not contradicted by clean unchanged HEAD',
    });
  }

  if (
    typeof declared.committed !== 'boolean'
    || typeof declared.pushed !== 'boolean'
    || !nonEmptyString(git.head)
    || typeof git.dirty !== 'boolean'
    || !nonEmptyString(before.head)
    || typeof before.dirty !== 'boolean'
  ) {
    checks.push(skipped('declared-vs-git-changed', 'declared commit/push or before/git head/dirty is missing'));
  } else {
    const declaredChanged = declared.committed || !declared.pushed;
    const gitChanged = git.head !== before.head || git.dirty !== before.dirty;
    checks.push({
      id: 'declared-vs-git-changed',
      pass: declaredChanged === gitChanged,
      detail: declaredChanged === gitChanged
        ? `declared changed=${declaredChanged} agrees with git changed=${gitChanged}`
        : `declared changed=${declaredChanged} but git changed=${gitChanged}`,
    });
  }

  const blocked = typeof deliveryState === 'string' && deliveryState.startsWith('blocked_');
  const hasBlockedHandoff = nonEmptyString(declared.stage) || nonEmptyString(declared.blocker);
  checks.push({
    id: 'blocked-missing-stage',
    pass: !blocked || hasBlockedHandoff,
    detail: blocked && !hasBlockedHandoff
      ? `${deliveryState} has neither declared.stage nor declared.blocker`
      : 'blocked delivery has a stage/blocker handoff or is not blocked',
  });

  return checks;
}
