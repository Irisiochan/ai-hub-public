import crypto from 'node:crypto';

/**
 * Hub MCP per-contact bearer.
 *
 * `/api/hub-mcp/:contactId` 此前豁免 session auth，调用方身份只看 URL 里的
 * contactId——硬边界实质是 Tailnet ACL。现在每个联系人有一个从 HUB_TOKEN
 * 派生的确定性 HMAC bearer：
 *   token = HMAC-SHA256(HUB_TOKEN, 'hub-mcp-v1\0' + contactId)
 * 网关在生成 CLI 客户端配置时注入对应 header，所以密钥从不落库；
 * 轮换 = 换 HUB_TOKEN（全部派生 token 一起失效）；
 * 撤销单个联系人 = 禁用联系人或关 delegation（路由层已有该检查）。
 *
 * mode:
 * - enforce：缺失/错误 bearer 一律 401 并留审计日志。
 * - warn：只审计不拒绝——给尚未注入 header 的存量客户端（如外部维护的
 *   grok CLI 配置）留出迁移窗口；HUB_MCP_AUTH_MODE=enforce 收口。
 * - HUB_TOKEN 未配置时无密钥可签，保持 tailnet-only 行为（disabled）。
 */

export type HubMcpAuthMode = 'enforce' | 'warn' | 'disabled';

export function hubMcpAuthMode(hubToken: string | undefined, envMode: string | undefined): HubMcpAuthMode {
  if (!hubToken) return 'disabled';
  return envMode === 'warn' ? 'warn' : 'enforce';
}

export function hubMcpBearerToken(hubToken: string, contactId: string): string {
  return crypto.createHmac('sha256', hubToken)
    .update(`hub-mcp-v1\0${contactId}`)
    .digest('base64url');
}

export function hubMcpBearerMatches(
  hubToken: string,
  contactId: string,
  authorizationHeader: string | undefined
): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? '');
  const received = match?.[1]?.trim() ?? '';
  if (!received) return false;
  const expected = hubMcpBearerToken(hubToken, contactId);
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}
