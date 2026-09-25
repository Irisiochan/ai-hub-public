export const EXECUTION_STANDING_MARKER = '【workflow execute standing v2】';

export function isExecutionStage(stage: string | null | undefined): stage is 'execute' | 'fix' {
  return stage === 'execute' || stage === 'fix';
}

export function executionStandingPrompt(stage: 'execute' | 'fix'): string {
  const scope = stage === 'fix'
    ? '只修审查列出的必须修项，以及修复引入的必要回归。不要把可选建议升级成新范围，不要顺手重构。'
    : '只实现已批准范围。发现超范围问题只报告，不自行扩成需求，不顺手重构。';
  return [
    EXECUTION_STANDING_MARKER,
    '最小改动。测试覆盖本次行为和相关回归，不为低影响改动堆叠无关测试。',
    scope,
    '正常退出、提交代码或自报完成都不算验收通过。独立评审确认该问题解决后才清零。',
    '同一问题跨 execute / fix 保留累计次数；不得靠换阶段、换模型或重建单据绕过两轮进 arbitration、第三轮转 User。',
  ].join('\n');
}

export function applyExecutionStanding(prompt: string, stage: string): string {
  if (!isExecutionStage(stage)) return prompt;
  if (prompt.includes(EXECUTION_STANDING_MARKER)) return prompt;
  // Trusted coordination markers must remain on line one for routing/mutexes.
  return `${prompt}\n\n${executionStandingPrompt(stage)}`;
}
