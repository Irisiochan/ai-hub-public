/** 中日韩字符通常接近 1 token；其余文本按约 4 字符/token。仅作本地趋势估算。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u3000-\u9fff\uf900-\ufaff]/.test(ch)) cjk++;
    else other++;
  }
  return Math.max(0, Math.ceil(cjk + other / 4));
}
