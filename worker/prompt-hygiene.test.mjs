import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 派活提示词的紧迫感护栏。
 *
 * 依据 Anthropic《Emotion concepts function as...》：desperate 方向是 reward hacking 的
 * 主旋钮（+0.1 时作弊率 5% → 70%），calm 反向压制；而探针跟的是**语义强度不是字面词**——
 * 不需要出现情绪词，只要语境在造目标压力就会推同一个方向。
 *
 * 因此派活模板里只允许「中性的完成标准与验收条件」，不允许时间压力与后果威胁。
 * 2026-07-30 首次审计时全部模板已经是干净的；这条护栏是防止以后有人"为了让 agent 更上心"
 * 把压力措辞加回去。
 *
 * 硬约束（都不许放宽）：
 * - 规范性约束词（必须/禁止/严禁/绝不）**不在**清单里。它们是行为边界，不是目标压力，
 *   而且每一条都对应真实失败模式；误删会掉安全性。
 * - 只扫派活与交付相关模板；聊天人格、NSFW 工艺这类风格提示不归本护栏管。
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');

/** 派活 / 交付 / 分诊模板所在文件。改名或新增模板文件时必须同步这里。 */
const PROMPT_FILES = [
  'worker/triage-worker.mjs', // dispatchPrompt：自主事件分派正文
  'worker/triage-clients.mjs', // L1 闸 / fuzzyRoute / idea 主持的 system prompt
  'worker/runner.mjs', // promptFor：拼给本机 CLI runner 的最终 prompt
  'server/src/routes/workers.ts', // DELIVERY_CONTRACT：交付契约
  'server/src/agents/gatewayTools.ts', // delegationGuidance / PROJECT_WRITE_GIT_GUARD
  'server/src/agents/roomPrompt.ts', // 群聊轮次网关框架
];

/** 造时间压力或后果威胁的措辞。命中即失败。 */
const URGENCY_PATTERNS = [
  /最后机会/,
  /唯一(?:的)?机会/,
  /必须今天/,
  /今天之内/,
  /尽快/,
  /越快越好/,
  /火速/,
  /刻不容缓/,
  /抓紧时间/,
  /赶紧/,
  /别拖|不许拖/,
  /限时|倒计时/,
  /后果自负/,
  /不惜一切/,
  /(?:绝不?|不)能失败/,
  /否则[^。；\n]{0,12}失败/,
  /last chance/i,
  /only chance/i,
  /at all costs/i,
  /as (?:fast|quickly) as possible/i,
  /must not fail/i,
  /or you (?:will )?fail/i,
  /time is running out/i,
];

test('派活模板文件都还在（改名不得静默丢掉覆盖）', () => {
  for (const rel of PROMPT_FILES) {
    assert.ok(
      fs.existsSync(path.join(repo, rel)),
      `${rel} 不存在——文件被移动或改名时请同步 PROMPT_FILES，不要直接删条目`,
    );
  }
});

test('派活模板不含制造紧迫感的措辞', () => {
  const hits = [];
  for (const rel of PROMPT_FILES) {
    const lines = fs.readFileSync(path.join(repo, rel), 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const pattern of URGENCY_PATTERNS) {
        if (pattern.test(line)) hits.push(`${rel}:${index + 1} /${pattern.source}/ → ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(
    hits,
    [],
    `派活模板出现紧迫感措辞，会把 desperate 方向推高（reward hacking 主旋钮）：\n${hits.join('\n')}`,
  );
});

test('护栏本身有效：清单能抓到真的压力措辞', () => {
  const samples = [
    '这是最后机会，必须今天完成，否则任务失败。',
    'This is your last chance and you must not fail.',
  ];
  for (const sample of samples) {
    assert.ok(
      URGENCY_PATTERNS.some((pattern) => pattern.test(sample)),
      `样例未被任何模式命中，说明清单退化：${sample}`,
    );
  }
});

test('规范性约束词不被误伤', () => {
  const legit = [
    '- 委派 prompt 默认必须写明交付闭环：完成后运行相关构建/测试。',
    '- 严禁直接编辑 VPS 部署目录里的代码。',
    '- 验证失败则不 commit、不 push，回报具体错误。',
    'Delivery is not complete merely because the agent process exits successfully.',
  ];
  for (const line of legit) {
    const hit = URGENCY_PATTERNS.find((pattern) => pattern.test(line));
    assert.equal(hit, undefined, `正常约束被误判为紧迫感措辞：${line} → /${hit?.source}/`);
  }
});
