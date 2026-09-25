/** Pure room-task view helpers (UI unit-tested, no React dependency). */
export function taskFileOf(taskPath: string): string {
  return taskPath.startsWith('tasks/') ? taskPath.slice('tasks/'.length) : taskPath;
}

export function taskStatusText(status: string): string {
  switch (status) {
    case 'open': return '待处理';
    case 'in_progress': return '执行中';
    case 'in_review': return '评审/发布中';
    case 'blocked': return '受阻';
    case 'closed': return '已关闭';
    case 'dropped': return '已丢弃';
    default: return status;
  }
}

/** Settled tasks stay in the ledger for audit but leave the User panel. */
export function isActiveRoomTask(status: string): boolean {
  return status !== 'closed' && status !== 'dropped';
}
