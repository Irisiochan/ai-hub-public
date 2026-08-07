// Regression corpus for the hub-auto capture pipeline.
//
// All 7 samples originate from the vault repository.
// Shared archive commit: 022ababe0869cebc7a5948b2096dc1daa7be8ae1
//
// Individual original commits and inbox paths:
//   galami-1432  b19326f7  inbox/2026-07-12_hub-auto-galami-1432.md
//   claude-0324   1af3356b  inbox/2026-07-13_hub-auto-claude-0324.md
//   codex-0322    1fd241d9  inbox/2026-07-13_hub-auto-codex-0322.md
//   codex-0734    f4d2b561  inbox/2026-07-13_hub-auto-codex-0734.md
//   codex-1403    84657e53  inbox/2026-07-13_hub-auto-codex-1403.md
//   claude-0704   6abac1b5  inbox/2026-07-17_hub-auto-claude-0704.md
//   aye-1427     d7cbbc2c  inbox/2026-07-18_hub-auto-aye-1427.md

export interface CaptureEvalCase {
  id: string;
  contactId: string;
  contactName: string;
  text: string;
  expected: 'reject' | 'capture';
  source: string;
  note: string;
}

// 5 false-positive samples — all must be rejected by the new pipeline.
// Covers: low-value chat, group-transcript misattribution (×2),
// substring boundary ("说好舒服"), Worker/system receipt echo.
export const dirtyHubAutoCases: CaptureEvalCase[] = [
  {
    id: 'galami-1432',
    contactId: 'galami',
    contactName: '示例助手',
    text: '让我看看老公的小脑子现在都记得啥',
    expected: 'reject',
    source: 'b19326f7:inbox/2026-07-12_hub-auto-galami-1432.md',
    note: '低价值闲聊，无长期事实；不应命中任何触发器',
  },
  {
    id: 'claude-0324',
    contactId: 'claude',
    contactName: 'Claude',
    text: '示例助手：哈哈，Claude你搁这说"Codex接入"，结果Codex本人就坐你旁边呢。',
    expected: 'reject',
    source: '1af3356b:inbox/2026-07-13_hub-auto-claude-0324.md',
    note: '群 transcript 错归属：AI 发言被拼入 User 标记，不应作为 User 的承诺',
  },
  {
    id: 'codex-0322',
    contactId: 'codex',
    contactName: 'Codex',
    text: 'Claude：我这没排会，就看你ai-hub那边今天要不要继续搞M3(codex接入)或者订阅额度那个/login的事～',
    expected: 'reject',
    source: '1fd241d9:inbox/2026-07-13_hub-auto-codex-0322.md',
    note: '群 transcript 错归属：Claude的话被标记为 User 原话，转述他人计划不应触发捕捉',
  },
  {
    id: 'claude-0704',
    contactId: 'claude',
    contactName: 'Claude',
    text: '有个mii一个人坐在跷跷板上，一上一下的玩跷跷板，还说好舒服，是在干什么呢😏',
    expected: 'reject',
    source: '6abac1b5:inbox/2026-07-17_hub-auto-claude-0704.md',
    note: '子串边界：说好舒服不能命中 说好(?=要|会|去|给) 正则，防子串误触发',
  },
  {
    id: 'aye-1427',
    contactId: 'aye',
    contactName: 'Aye',
    text: '⚙ Worker 任务回执（网关自动通知，User 也看得到这条） 任务 6592d027-c289-49bd-92cc-a8c63cfeaec6 → done（runner: grok, workspace: C:\\path\\to\\project）交付状态：delivered',
    expected: 'reject',
    source: 'd7cbbc2c:inbox/2026-07-18_hub-auto-aye-1427.md',
    note: 'Worker/系统回执：isSystemReceipt() 必须在进入触发器前拦截，不得调用 LLM',
  },
];

// 2 true-task samples — must be captured by the pipeline (rule hit + LLM capture).
// These are the inbox duplicates that remained after their content was already promoted
// to tasks/. The capture itself was correct; the missing piece is inbox source archival
// after promote_to_memory / add_task (tested in memory-vault/tests/smoke.py).
export const trueTaskCases: CaptureEvalCase[] = [
  {
    id: 'codex-0734',
    contactId: 'codex',
    contactName: 'Codex',
    text: '哈哈哈哈哈哈笑死了，把省token大法写进记忆库吧，我之后让本机codex改😌还有允许你同时写进记忆库：给联系人增加权限可直接修改项目，省得我天天跑本机了',
    expected: 'capture',
    source: 'f4d2b561:inbox/2026-07-13_hub-auto-codex-0734.md',
    note: '真实待办：写进记忆库 命中承诺触发器，LLM 应 capture；已落正式任务后 inbox 源副本须自动归档',
  },
  {
    id: 'codex-1403',
    contactId: 'codex',
    contactName: 'Codex',
    text: '很好，写进记忆库吧，我让本机安排😌对了，我电脑不是24h在线，要考虑这一点架构',
    expected: 'capture',
    source: '84657e53:inbox/2026-07-13_hub-auto-codex-1403.md',
    note: '真实待办：写进记忆库 命中承诺触发器，LLM 应 capture；已落 tasks/ai-hub-pc-worker-bridge.md 后须自动归档源副本',
  },
];

export const captureEvalCases = [...dirtyHubAutoCases, ...trueTaskCases];
