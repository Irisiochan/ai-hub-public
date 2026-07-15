import { CodexAppServerBackend } from '../src/agents/codexAppServer.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const limits = await CodexAppServerBackend.readRateLimits({
  cliPath: config.codex.cliPath,
  cwd: config.agentsDir,
  log: (message) => console.error(`[codex-quota-smoke] ${message}`),
});

if (!limits.primary && !limits.secondary) {
  throw new Error('account/rateLimits/read returned no primary or secondary window');
}

const safe = (window: typeof limits.primary) =>
  window
    ? {
        remainingPct: Math.round(100 - window.usedPercent),
        windowDurationMins: window.windowDurationMins,
        resetsAt: window.resetsAt,
      }
    : null;

console.log(JSON.stringify({ primary: safe(limits.primary), secondary: safe(limits.secondary) }));
