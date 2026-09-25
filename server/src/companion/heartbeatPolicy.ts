export const HEARTBEAT_SILENT_RE = /^HEARTBEAT_OK[\s。.!～~]*$/;

// Treat opaque interaction tools conservatively: they can submit a write as well.
export function heartbeatWriteTool(name: string): boolean {
  const leaf = name.split(/__|[./:]/).at(-1) ?? name;
  // Unknown tools (including shell execution) cannot be proved read-only from their name.
  return !/^(?:camera_snap|search_vault|read_file|get_context|get_core_context|get_task_context|get_turn_time|get_related|get_facts|list_inbox|worker_job_status|taobao_(?:list_available_pages|navigate|navigate_to_url|close_page|get_current_tab|read_page_content|scroll_page|scan_page_elements|inspect_page|search_products|get_product_skus|get_browse_history))$/i.test(leaf);
}

export function heartbeatReceipt(text: string, tools: string[]): string {
  if (text.trim() && !HEARTBEAT_SILENT_RE.test(text.trim())) return text;
  const writes = [...new Set(tools.filter(heartbeatWriteTool))];
  if (!writes.length) return text;
  return `本轮尝试了以下操作：${writes.join('、')}。模型没有提供操作回执，结果需要核对；不能据此认定操作成功。为避免重复操作，本轮不会自动重试。`;
}

export function retryableHeartbeatError(text: string): boolean {
  if (/401|403|400|invalid|unauthorized|forbidden|schema|权限|认证|连续崩|lockout/i.test(text)) return false;
  return /\b(?:408|429|500|502|503|504|529)\b|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network|超时|暂时不可用/i.test(text);
}
