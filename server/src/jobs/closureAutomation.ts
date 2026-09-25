import type { JobRow } from '../platform/index.js';
import { structuredReceiptFields } from './receiptFields.js';

/** Release gate reused by explicit release_execute: the frozen merge result must
 * prove the full validation set. Pure check, never schedules anything. */
export function hasRequiredMergeTests(job: JobRow): boolean {
  const reported = new Set((structuredReceiptFields(job).tests ?? [])
    .filter((item) => item.status === 'pass')
    .map((item) => item.suite.toLowerCase()));
  return [
    'server npm run pretest',
    'server npm test',
    'web npm test',
    'smoke:deploy-drain',
    'smoke:turn-timeouts',
    'smoke:deploy-resume',
  ].every((suite) => reported.has(suite));
}

export interface ClosureCommandTarget {
  file: string;
  args: string[];
}

export interface ClosureCommand {
  kind: 'merge' | 'deploy';
  win: ClosureCommandTarget;
  posix: ClosureCommandTarget;
  timeoutMs: number;
}

export const MERGE_CLOSURE_TIMEOUT_MS = 45 * 60 * 1000;
export const DEPLOY_CLOSURE_TIMEOUT_MS = 20 * 60 * 1000;

export interface MergeClosureEvidence {
  roomId: string;
  taskPath: string;
  candidateSha: string;
  reviewStatus: string;
  reviewEvidenceId: number | null;
}

/** Deterministic merge command stamped into job options. The Worker runs
 * closureCommand directly (no model); args are passed as an array to spawn,
 * never re-shelled. The win target carries the full -ReleaseEvidence JSON
 * verbatim; the posix Node entry mirrors the prompt's fixed Linux command. */
export function buildMergeClosureCommand(input: {
  taskPath: string;
  branch: string;
  frozenSha: string;
  baselineSha: string;
  releaseEvidence: MergeClosureEvidence;
  /**
   * Set when the candidate ran against a frozen VPS project target. Without
   * it merge-close-job.mjs falls back to repo ai-hub and runs
   * `npm --prefix server` inside, say, an ai-dashboard checkout.
   */
  repo?: { repoId: string; repoDir: string } | null;
  /**
   * R3: the candidate's own workspace. Stamped as -RepoDir/--repo-dir (never
   * --repo) when there is no frozen projectTarget, so a non-ai-hub checkout
   * resolves its own .ai-hub-merge.json manifest; checkouts without one keep
   * the historical ai-hub default byte-for-byte.
   */
  repoDir?: string | null;
  /** Open rooms: a stale candidate is rebased by the script itself and merged
   * without re-review when its own patch replays identically (posix entry
   * only; the ps1 keeps reporting stale). */
  autoRebase?: boolean;
  /** R2-D: review-approved patch, applied by the script after Gate + rebase
   * and verified identical before the validation set (posix entry only;
   * PC workspaces are rejected at review_submit so the ps1 never takes it). */
  reviewPatch?: { b64: string; sha256: string } | null;
}): ClosureCommand {
  const evidenceJson = JSON.stringify(input.releaseEvidence);
  const frozen = input.repo && input.repo.repoId && input.repo.repoId !== 'ai-hub' ? input.repo : null;
  const repoArgs = frozen
    ? ['--repo', frozen.repoId, '--repo-dir', frozen.repoDir]
    : [];
  // R3: no frozen target → hand the candidate workspace to both entries as a
  // directory only (no --repo/-Repo), so manifests resolve and everything
  // else stays exactly as before.
  const workspaceDir = !frozen && input.repoDir ? input.repoDir : null;
  return {
    kind: 'merge',
    win: {
      file: 'deploy/merge-close-job.ps1',
      args: [
        '-FrozenSha', input.frozenSha,
        '-BaselineSha', input.baselineSha,
        '-WorkingBranch', input.branch,
        '-ReleaseEvidence', evidenceJson,
        ...(workspaceDir ? ['-RepoDir', workspaceDir] : []),
      ],
    },
    posix: {
      file: 'deploy/merge-close-job.mjs',
      args: [
        '--frozen-sha', input.frozenSha,
        '--baseline-sha', input.baselineSha,
        '--working-branch', input.branch,
        // Same fail-closed Gate L as the ps1: without the evidence the Node
        // entry refuses to run at all, so a Linux lane can never push master
        // with no ledger re-verification.
        '--release-evidence', evidenceJson,
        ...repoArgs,
        ...(workspaceDir ? ['--repo-dir', workspaceDir] : []),
        ...(input.autoRebase ? ['--auto-rebase'] : []),
        ...(input.reviewPatch ? ['--review-patch-b64', input.reviewPatch.b64, '--review-patch-sha256', input.reviewPatch.sha256] : []),
      ],
    },
    timeoutMs: MERGE_CLOSURE_TIMEOUT_MS,
  };
}

/** Deterministic deploy command stamped into job options. */
export function buildDeployClosureCommand(input: {
  frozenSha: string;
}): ClosureCommand {
  return {
    kind: 'deploy',
    win: {
      file: 'deploy/room-deploy-job.ps1',
      args: ['-Sha', input.frozenSha],
    },
    posix: {
      file: 'deploy/room-deploy-job.mjs',
      args: ['--sha', input.frozenSha],
    },
    timeoutMs: DEPLOY_CLOSURE_TIMEOUT_MS,
  };
}
export function buildMergeClosurePrompt(input: {
  parentJobId: string;
  reviewJobId: string;
  taskPath: string;
  roomId: string;
  branch: string;
  frozenSha: string;
  baselineSha: string;
  releaseEvidence: { roomId: string; taskPath: string; candidateSha: string; reviewStatus: string; reviewEvidenceId: number | null };
  repo?: { repoId: string; repoDir: string } | null;
  /** R3: candidate workspace, rendered as -RepoDir/--repo-dir when there is no frozen repo (never --repo). */
  repoDir?: string | null;
}): string {
  // before.head is kept as release-time evidence only (it is routinely NOT an
  // ancestor of a rebased frozen SHA); the merge baseline is computed live by
  // the script as merge-base(<remote>/<target>, frozen). The fixed command
  // below already carries the full -ReleaseEvidence — the Worker runs it
  // verbatim and never rebuilds the evidence argument.
  const evidenceJson = JSON.stringify(input.releaseEvidence).replace(/'/g, "''");
  const frozenPrompt = input.repo && input.repo.repoId && input.repo.repoId !== 'ai-hub' ? input.repo : null;
  const workspacePrompt = !frozenPrompt && input.repoDir ? input.repoDir : null;
  const repoSuffix = frozenPrompt
    ? ` --repo ${frozenPrompt.repoId} --repo-dir ${frozenPrompt.repoDir}`
    : '';
  const dirSuffix = workspacePrompt ? ` --repo-dir ${workspacePrompt}` : '';
  const winDirSuffix = workspacePrompt ? ` -RepoDir ${workspacePrompt}` : '';
  return [
    '【harness-auto merge closure v1】',
    '这是 review 严格判定 APPROVE 后规则化创建的车道 A 机械收口单。只执行合并/验证/push；禁止 SSH、部署、重启、改需求或修测试失败。',
    `parentJobId=${input.parentJobId}`,
    `reviewJobId=${input.reviewJobId}`,
    `taskPath=${input.taskPath || '未提供'}`,
    `workingBranch=${input.branch}`,
    `frozenSha=${input.frozenSha}`,
    `baselineSha=${input.baselineSha}`,
    '',
    '运行固定命令（原样执行，不得自行重建 -ReleaseEvidence；其中的 candidateSha 为完整 40 位，另附 roomId/taskPath/reviewStatus/reviewEvidenceId）：',
    `powershell -ExecutionPolicy Bypass -File deploy/merge-close-job.ps1 -FrozenSha ${input.frozenSha} -BaselineSha ${input.baselineSha} -WorkingBranch ${input.branch} -ReleaseEvidence '${evidenceJson}'${winDirSuffix}`,
    `Linux/VPS 用 Node 入口（与 ps1 同门，同一轮只用其一）：node deploy/merge-close-job.mjs --frozen-sha ${input.frozenSha} --baseline-sha ${input.baselineSha} --working-branch ${input.branch} --release-evidence '${evidenceJson}'${repoSuffix}${dirSuffix}`,
    'Worker 将直接执行 closureCommand，不经模型（确定性执行，回执为脚本原始 stdout）。',
    '',
    '脚本必须依次执行账本自检（ReleaseEvidence 候选 == frozen 且 review approved；这只是本地自检，不是硬闸）→ 服务端回验（用 bearer 回调网关 GET /api/room-tasks/:room/:task 核对账本 candidate_sha 与 review_status，有 roomId 时必须通过，网关不可达即失败，不一致即停）→ Gate0（当前工作分支/HEAD 冻结、工作树 clean）→ 新鲜度检查（<remote>/<target> 为 frozen 祖先，否则按 stale 原样报告，不得 push/改写）→ 现算合入基线 merge-base(<remote>/<target>, frozen) 写进回执（-BaselineSha 只是 release 时的 before.head 证据，仅记录不做祖先断言）→ 在 frozen HEAD 原地跑验证集（不切分支）→ push frozen:refs/heads/master → 远端 SHA 复核。',
    '任何 Gate 或验证失败都必须停下，不得修代码、降级验证、force push、回滚、部署或另建分支。stale 输出（含 masterSha）原样上报，由网关自动把任务交回 execute 并附 rebase 目标。',
    '成功后 stage=delivered_waiting_deploy、nextOwner=harness-deploy；回执 JSON 必须申报 branch=master 对应的结构化 diffstat/changedFiles/tests。代码评审通过与部署后验证分别记录。',
  ].join('\n');
}

export function buildDeployClosurePrompt(input: {
  mergeJobId: string;
  parentJobId: string;
  taskPath: string;
  frozenSha: string;
}): string {
  return [
    '【harness-auto deploy closure v1】',
    '这是车道 A 全量验证并 push 后规则化创建的车道 B 机械部署单。只复用现有 HTTP 部署通道；禁止改文件、SSH、绕过 drain 或省略部署前在途检查。',
    `mergeJobId=${input.mergeJobId}`,
    `parentJobId=${input.parentJobId}`,
    `taskPath=${input.taskPath || '未提供'}`,
    `frozenSha=${input.frozenSha}`,
    '',
    `唯一命令（Windows 用 ps1，Linux/VPS 用 Node 入口，同一轮只用其一）：powershell -ExecutionPolicy Bypass -File deploy/room-deploy-job.ps1 -Sha ${input.frozenSha}`,
    `Linux/VPS 上唯一命令：node deploy/room-deploy-job.mjs --sha ${input.frozenSha}`,
    'Worker 将直接执行 closureCommand，不经模型（确定性执行，回执为脚本原始 stdout）。',
    'room-deploy-job.ps1 保留 prepareDeployDrain、部署前房间在途检查、最长等待、restart 前复检、deploy ok 与 /api/health 验收；不得换成 SSH 或直接运行 update.sh。',
    '成功后 stage=closed_loop、nextOwner=无需后续动作；失败则如实报告，不得重试成绕闸路径。代码评审 APPROVE 不能代替本次部署后验证。不得在部署验证前关闭父任务。',
  ].join('\n');
}

// (Automatic merge/deploy creators removed; explicit release_execute reuses the builders above.)
