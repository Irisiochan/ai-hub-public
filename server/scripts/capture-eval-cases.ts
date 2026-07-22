// Synthetic public regression corpus for the hub-auto capture pipeline.
// Keep real chat exports and private vault commit references out of this repo.

export interface CaptureEvalCase {
  id: string;
  contactId: string;
  contactName: string;
  text: string;
  expected: 'reject' | 'capture';
  source: string;
  note: string;
}

export const dirtyHubAutoCases: CaptureEvalCase[] = [
  {
    id: 'low-value-chat',
    contactId: 'assistant-a',
    contactName: '助手甲',
    text: '看看你现在都记得什么',
    expected: 'reject',
    source: 'synthetic',
    note: 'Low-value chat is not durable memory.',
  },
  {
    id: 'room-transcript-a',
    contactId: 'assistant-b',
    contactName: '助手乙',
    text: '助手甲：我明天会继续处理接口。',
    expected: 'reject',
    source: 'synthetic',
    note: 'Another member transcript is not the user commitment.',
  },
  {
    id: 'room-transcript-b',
    contactId: 'assistant-c',
    contactName: '助手丙',
    text: '助手乙：记得下周发布。',
    expected: 'reject',
    source: 'synthetic',
    note: 'Quoted room text must not be attributed to the user.',
  },
  {
    id: 'substring-boundary',
    contactId: 'assistant-a',
    contactName: '助手甲',
    text: '故事里还说好舒服。',
    expected: 'reject',
    source: 'synthetic',
    note: 'The 说好 trigger must respect its boundary.',
  },
  {
    id: 'system-receipt',
    contactId: 'assistant-a',
    contactName: '助手甲',
    text: '⚙ Worker 任务回执（网关自动通知，Iris 也看得到这条） 任务 demo → done 交付状态：delivered',
    expected: 'reject',
    source: 'synthetic',
    note: 'System receipts are rejected before LLM review.',
  },
];

export const trueTaskCases: CaptureEvalCase[] = [
  {
    id: 'explicit-ledger-task',
    contactId: 'assistant-a',
    contactName: '助手甲',
    text: '请把省 token 方案写进记忆库，我之后安排开发。',
    expected: 'capture',
    source: 'synthetic',
    note: 'Explicit durable task request.',
  },
  {
    id: 'dated-reminder',
    contactId: 'assistant-b',
    contactName: '助手乙',
    text: '明天下午三点提醒我做发布回归。',
    expected: 'capture',
    source: 'synthetic',
    note: 'Dated reminder should enter the review pipeline.',
  },
];

export const captureEvalCases = [...dirtyHubAutoCases, ...trueTaskCases];
