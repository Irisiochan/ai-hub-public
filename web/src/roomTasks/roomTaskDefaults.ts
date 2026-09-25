/** W3 建账表单纯逻辑（无 React 依赖，可被 web 单测直接引用）。 */

export interface ProjectTargetInfo {
  repoId: string;
  platform: string;
  workerId: string;
  workspace: string;
}

export interface PcNeedFlags {
  camera: boolean;
  taobao: boolean;
  ssh: boolean;
  win32: boolean;
}

/** 从 task_path `tasks/<slug>.md` 取任务 slug；非法返回 null。 */
export function taskSlugOf(taskPath: string): string | null {
  const match = /^tasks\/([^/\\]{1,100})\.md$/i.exec(String(taskPath ?? '').trim());
  if (!match) return null;
  const slug = match[1].trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(slug) && !/^review-[0-9a-f]{7,64}$/i.test(slug)
    ? slug
    : null;
}

/**
 * W3 默认工作区：仓库有映射时返回 VPS 围栏工作区 `<root>/<slug>`，
 * 否则返回 null（调用方回退 PC 工作区选择）。
 */
export function defaultWorkspaceFor(
  repoId: string,
  taskPath: string,
  targets: ProjectTargetInfo[],
): string | null {
  const target = (targets ?? []).find((item) => item.repoId === String(repoId ?? '').trim());
  if (!target) return null;
  const slug = taskSlugOf(taskPath);
  if (!slug) return null;
  return `${target.workspace.replace(/\/+$/, '')}/${slug}`;
}

/** 是否声明了任一 PC-only 能力（声明即走 PC 工作区，不再默认 VPS）。 */
export function needsPcSelected(flags: PcNeedFlags): boolean {
  return Boolean(flags.camera || flags.taobao || flags.ssh || flags.win32);
}

/** 表单默认仓库：有映射默认第一个（VPS 优先），否则空（PC 手动）。 */
export function defaultRepoId(targets: ProjectTargetInfo[]): string {
  return targets && targets.length > 0 ? targets[0].repoId : '';
}
