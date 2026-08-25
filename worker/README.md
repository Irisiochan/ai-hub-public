# PC Worker launcher

`worker-launcher.ps1` is the single Windows entrypoint for the PC Worker. It owns the
HKCU logon entry, single-instance lock, Tailscale/gateway wait, child process,
crash backoff and local status.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action install
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action start
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action restart
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\worker-launcher.ps1 -Action stop
```

At logon the installed command waits 300 seconds, then waits for Tailscale and the
gateway before starting Node. Once those checks pass, it also starts one detached
offsite-backup catch-up check. The catch-up waits for SSH, skips when the newest
verified archive is less than 20 hours old, and otherwise pulls and verifies a new
archive. `worker-state.json` is the single durable state file: its `launcher`
section reports `online | waiting | restarting | failed | stopped`, PIDs, restart
count and the last error, while `jobs` and `events` hold Worker recovery data.
`state-store.mjs` serializes launcher and Worker writes through one lock so the
two processes cannot overwrite each other's section. A legacy
`launcher-state.json` is read only as a migration fallback.

`maxConcurrent` defaults to `1` and is capped at `8`. A value of `2` is the
recommended starting point for a normal PC. The server enforces both the slot
limit and one active job per exact workspace, so two jobs may run together only
when their workspaces do not overlap.

Workspace entries can be either a path string or an object with a delivery mode:

```json
{
  "workspaces": [
    "C:/path/to/code-workspace",
    {
      "path": "C:/path/to/managed-vault-content",
      "deliveryMode": "trust-cli"
    }
  ]
}
```

Path strings default to `git-check`. Use `trust-cli` only for a content vault
whose own managed sync may write or commit files after the runner exits. Code
repositories, including the Memory Vault implementation repository, should stay
on `git-check`. The worker still honors an explicit final
`{"delivery":{"committed":...,"pushed":...}}` declaration from the runner.

The ai-hub Worker panel can pause or resume job acceptance. Pausing keeps only a
lightweight control heartbeat so the panel can wake the worker remotely; it does
not kill a running job. The pause is durable user intent: it survives reconnects,
child-process restarts, and Windows reboots, and only the panel's explicit resume
turns claiming back on. The worker also refuses to start when another live worker
process already holds the state file's `.lock`, because two processes against one
worker row used to ping-pong the gateway state and break the pause.

The claim response carries protocol version `2` and the current delivery
contract. The Worker inserts that server-provided text into the runner prompt;
contract wording can therefore change without a PC Worker restart. Runner
permission flags are generated from the table in `runner.mjs`.

### Codex sandbox and `danger-full-access`

`codexSandboxMode: "danger-full-access"` is a **worker-side, host-level trust
decision**, and it changes what the workspace allowlist means:

- Under the normal `workspace-write` sandbox, the allowlist is backed by real
  filesystem isolation — the runner cannot write outside its workspace.
- Under `danger-full-access`, the allowlist only picks the working directory.
  It is **no longer a filesystem boundary**: any shell-capable job can touch
  the whole machine. Enable it only where every allowed requester is trusted.
- Escalation requires this worker config. Job payloads cannot turn it on —
  fields like `options.sandbox` or a `codexSandboxMode` smuggled into the job
  are ignored (pinned by `runner.test.mjs`), and read-only jobs are still
  forced to `read-only` even when the passthrough is configured.
- Session resume explicitly re-applies the job's exact sandbox via
  `-c sandbox_mode="…"` (codex `exec resume` has no `--sandbox` flag), so
  fresh and resumed runs cannot drift apart.

If the Node Worker restarts with an active job, it first checks the saved child
PID. A live child is reattached and kept leased. If the child is gone but a
Claude/Codex/Grok session id was captured, the Worker performs one automatic
resume. Jobs without either proof become `interrupted`; the server keeps a
10-minute `recovering` window before making that terminal.

## Autonomous triage worker

`triage-worker.mjs` is the VPS-side event gate. It keeps a durable SQLite queue,
uses DeepSeek Flash for strict-JSON L1 triage, routes by contact
`config.routing`, and falls back to Flash again for L2.5 fuzzy recipient
selection when rules and the L1 suggestion both miss. Dispatches go through the
normal AI Hub message API. Unroutable actionable events are parked in Memory
Vault `inbox/` with the `triage-backlog` tag.

Module layout (split 2026-08-19; behavior-preserving):

- `triage-worker.mjs` — lifecycle only: config load, constructor, run loop,
  sources/webhook wiring, maintenance mode, shutdown. Domain methods are
  mounted onto `TriageWorker.prototype` from `worker-*.mjs` mixins
  (`followups` / `coordination` / `proactive` / `outcomes` / `backlog` /
  `reminders` / `idea-diary` / `pipeline`), sharing flags, logging, and
  state-key constants via `worker-shared.mjs`.
- `triage-core.mjs` — pure domain functions (config normalizers, planners,
  prompts, parsing). It re-exports `triage-shared.mjs` (constants, stableJson,
  normalizeEvent, Shanghai day helpers) and `triage-store.mjs` (the SQLite
  `TriageStore`), so existing imports keep working unchanged.
- `triage-migrations.mjs` — versioned schema migrations (user_version, one
  transaction per migration).

Requirements:

- Node.js 22.13 or newer (`node:sqlite` is used for the queue).
- A dedicated DeepSeek API key. Do not put Claude, Codex, or Grok subscription
  credentials in this service.
- Hub and Memory Vault tokens supplied through environment variables, never in
  the JSON config.

```bash
cd worker
cp triage.config.example.json /etc/ai-hub/triage.json
node triage-worker.mjs /etc/ai-hub/triage.json --once
node triage-worker.mjs /etc/ai-hub/triage.json --metrics
```

Run only the daily Agenda shadow once:

```bash
node triage-worker.mjs /etc/ai-hub/triage.json --once --agenda
```

Without a local production config, `node triage-worker.mjs --once --agenda`
prints a health-gate quiet reason and exits without contacting the Hub or Vault.

Set current DeepSeek prices in `deepseek.pricing`; zero means cost metrics are
unknown rather than guessed. The daily event and cost breakers, per-recipient
daily limit, and cooldown are all enforced before dispatch.

### Maintenance mode (store open/migration failure)

If the SQLite store cannot be opened or migrated at startup (failed migration,
schema newer than the binary, corrupt file), the worker no longer crash-loops
under systemd. It enters maintenance mode instead:

- The webhook stays up. `GET /health` reports `status: "maintenance"` with the
  failure reason; `POST /event` appends events to
  `<stateFile>.maintenance-intake.jsonl` and answers
  `202 {status: "maintenance-intake"}`.
- Everything on the dispatch side is disabled: no sources, no reminders, no
  coordination scan, no vault outbox, no event processing. A warning heartbeat
  is logged every 10 minutes.
- One-shot commands (`--once`, `--metrics`, `--task-reminders`) fail fast with
  exit code 1 instead of idling.
- After the operator fixes the store and restarts, the intake journal is
  replayed through the normal enqueue path (event ids derive from `dedupeKey`,
  so replay is idempotent) and archived as `*.replayed-<timestamp>`.

Startup logs `triage db ready {schemaFrom, schemaTo}` on every healthy boot, so
production migrations leave an auditable journal line.

### Daily Agenda shadow

`agenda` defaults to enabled and runs once per Shanghai wall-clock day at 09:00.
It inherits `coordination.roomId` and `coordination.hostName`; `agenda.roomId` and
`agenda.hostName` can override those values. The shadow reads `list_inbox`,
`get_task_context`, and `GET /api/jobs`, then deterministically sorts by due date,
P priority, and creation date. It posts at most one three-part digest (`would-auto`,
`would-ask`, `deferred / 异常`) with `trigger:false`, `capture:false`, and zero
reaction rounds. `would-auto` is observational only: Agenda never calls a Vault
write tool and never creates, updates, or dispatches a job.

The per-Shanghai-date state key makes same-day reruns idempotent. A separate v3
increment cursor in `triage_source_state` remembers each item's fingerprint,
first-seen date, and last date it was actually expanded, plus equivalent
job-status observations. Unchanged undated tasks are suppressed for
`agenda.resurfaceDays` (default 7) and then surface again; today/overdue tasks
surface daily. Content, mode/tier, priority, due-state, or job-status changes
surface immediately. Display overflow is never marked shown: unseen entries are
rotated ahead of previously expanded entries until every item has appeared.
Reconcile and deferred detail each show at most eight rows. A compact overview
reports open tasks, expanded and suppressed counts, and oldest pending age.
Fold counts and naturally changing age values do not affect the digest
fingerprint, so a next-day run with no real increment stays quiet. Existing v2
fingerprint-only cursor values are read compatibly and resurface once on upgrade.

When `coordination.tasksDir` is configured, Agenda reads each listed task file
and classifies its frontmatter first: subject to the existing T2/T3 safety
patterns, `mode: auto` is a T1 shadow candidate, while `mode: ask` or a readable
file with no mode is at least T2. An unreadable file falls back to the v1 title
classifier. Maintenance mode or an unavailable Vault suppresses `would-auto`;
an unavailable jobs API only adds one degraded reconcile line and does not block
the task/inbox sections.

### Backlog dispatch claims

Scheduled backlog sweeps read the authoritative `get_task_context` snapshot,
not a keyword search. Before L1 runs, the worker deterministically removes:

- `worker-tail-*` and `deploy-*` handoff tasks;
- tasks in the future-seven-days section;
- any exact `taskPath` already dispatched by this worker while that path
  remains open.

An actionable L1 result must copy one eligible `taskPath` exactly. The claim is
written to the worker SQLite state only after the Hub accepts the dispatch.
Repeating timer wakes therefore stop before L1 and cannot reassign the same
open task. When the path disappears from `get_task_context` (done/dropped), its
claim is pruned, so an explicit later reopen can be handled again.

### Outcome collection

Every Hub-accepted task or daily delivery stores the returned message anchor and
starts as `unknown`. A model-free collector polls messages after that exact
anchor and only upgrades labels when it has positive evidence:

- `engaged`: a later, non-automated `sender=user` message exists in the same contact;
- `rejected`: that manual message explicitly asks to stop sending, reminding, or dispatching;
- `accepted`: the exact `taskPath` leaves the open-task snapshot and a persisted
  `update_task → done` tool result confirms why;
- `reworked`: a current `worker-tail-*` or `deploy-*` body links the exact task path or event id.

Silence remains `unknown`; it is never treated as rejection. Label upgrades are
monotonic (`unknown → engaged → accepted → reworked → rejected`) so later weak
signals cannot erase stronger evidence. The outcome row stores message/task ids,
not reply text. `/health` exposes `metrics.outcomes.labels`, known/strong counts
and ratios, and the last non-unknown label timestamp.

```json
{
  "outcomes": {
    "enabled": true,
    "intervalMinutes": 5,
    "maxAgeDays": 30,
    "batchSize": 50
  }
}
```

`routing.rules` wins over the L1 suggestion, and the Flash fuzzy fallback only
runs when no candidate exists at all. A rules table that covers every category
therefore disables L2.5 completely — leave the long tail (`other`, and anything
else without an obvious owner) unmapped if you want the fallback to run.

### Proactive daily companion

A separate timer source with `"mode": "daily"` (and category `daily`) asks L1
whether User should get a proactive message: care/routine nudges, practical
reminders, or light chat openers are all allowed. This path is independent of
the task/backlog gate:

- **Model routing only** among `proactive.recipients` (default `claude`, `codex`,
  `aye`). Static `routing.rules` never override daily category.
- **Shanghai quiet hours** default `00:00–09:00` — the daily timer does not emit
  inside that window, and any queued daily event is forced to NO_OP.
- **Separate daily pool**: `proactive.dailyDispatchLimit` (default 10) counts
  Shanghai-calendar-day dispatches in delivery pool `daily`. Task per-recipient
  `dailyLimit` / cooldown only count pool `task`, so companion outreach does not
  burn work quotas.
- **Natural minimum cadence**: `minDailyDispatches` defaults to 1. If no daily
  message has been delivered by `forceAfterHour` (default 18:00 Shanghai), the
  next wake must choose one low-pressure message. `minimumGapMinutes` defaults
  to 180 so later checks cannot spam.
- **Real context**: L1 receives a compact current task snapshot, the three most recent
  contact interaction timestamps, and the last daily delivery timestamp. Daily delivery
  mode is trusted from the event source only; a normal task cannot enter the
  daily pool by returning category `daily`.
- Timer summary is rebuilt each wake with the current Asia/Shanghai clock.

```json
{
  "proactive": {
    "enabled": true,
    "dailyDispatchLimit": 10,
    "minDailyDispatches": 1,
    "forceAfterHour": 18,
    "minimumGapMinutes": 180,
    "silentStartHour": 0,
    "silentEndHour": 9,
    "recipients": ["claude", "codex", "aye"]
  },
  "sources": [
    {
      "id": "daily-check-in",
      "type": "timer",
      "mode": "daily",
      "intervalMinutes": 45,
      "jitterSeconds": 900,
      "category": "daily",
      "summary": "Proactive daily companion check for User."
    }
  ]
}
```

### Due and overdue task reminders

`taskReminders` is a deterministic scan of memory-vault's open-task snapshot; it
does not ask the daily companion model whether a dated task is important. A task
is emitted once when it enters each stage: due today and overdue. Tasks whose
due date is still ahead stay quiet until the day itself. The stable key is
`task path + due date + stage`, so repeated scans are NO_OP while a due-date
change creates a new reminder. Tasks without a due date and tasks no longer
open are ignored, and every queued reminder is checked against a fresh snapshot
immediately before delivery.

The feature is disabled when `taskReminders.enabled` is absent. Deploy the code
first, run the read-only production shadow, and only then opt in explicitly.

The scanner shares the proactive recipient allow-list and Shanghai quiet hours,
but not the daily companion minimum-gap gate. Failed dispatches retry the same
event and Hub idempotency key, so an uncertain response cannot create duplicate
notifications. Use `--reminder-shadow` to print current candidates without
enqueuing or dispatching them; use `--once --task-reminders` for a real one-shot
scan.

```json
{
  "taskReminders": {
    "enabled": true,
    "intervalMinutes": 45,
    "jitterSeconds": 900,
    "recipient": "claude"
  }
}
```

### Daily idea room

A timer source with `"mode": "idea"` uses DeepSeek Flash to choose one free-form
discussion topic and either `@all` or a purposeful subset of a configured room.
The host message is stored as `sender=room-host`, rendered as `DS 主持`, and never
enters Memory Vault capture as if User had authored it. The worker polls the
durable room-round status, fetches the transcript, then posts a Flash-generated
wrap-up without opening another member round.

- After the wrap-up is accepted by room-host, `idea.writeDiary` (default `true`)
  queues one distilled `write_diary` entry. It stores the topic, metadata,
  participation counts/names, DS wrap-up, and an AI Hub message-range pointer;
  the full transcript is never copied into Memory Vault.
- `idea.dailyDispatchLimit` defaults to 1 and counts the independent Shanghai-day
  delivery pool `idea`; task and daily-companion quotas are untouched.
- `reactionRounds` is clamped to 0–3 and defaults to 2.
- Recently completed topics are fed back into Flash. A new topic cannot reuse either
  of the previous two semantic categories, so every consecutive three are distinct.
- The daily companion quiet hours also suppress idea starts.
- `/health` exposes `ideaPoolDispatched`, `ideaChecks`, `ideaNoops`, and
  `lastIdeaDeliveryAt`.
- Diary delivery adds `ideaDiaryPending`, `ideaDiaryRetrying`,
  `ideaDiariesWritten`, and `ideaDiaryLastError` to `/health`.
- The diary slug is stable for the idea event plus `summaryMessageId`, and its
  date uses the Asia/Shanghai completion day. The worker persists the request in
  SQLite before marking the idea event dispatched, so event replay cannot create
  a second diary.
- Vault failures never reopen the completed room round or repeat its mentions.
  They remain in the durable outbox with bounded backoff and structured warning
  logs until a later retry succeeds. Set `idea.writeDiary` to `false` only to
  disable this post-discussion write; room-host capture behavior is unchanged.

Timer sources fire after `intervalMinutes` plus a fresh random jitter below
`jitterSeconds`, so consecutive wakes are never closer than the interval. Only
the first wake after start may land early, inside the jitter window alone.

### Diary rollup

`log_daily` 和 `write_diary` 都得模型主动开口调用，没有自动捕捉——忙起来就没人写，
diary 会整周空白。`diary-rollup` 源把这件事从「靠自觉」改成「事后结算」：每天固定时刻
拉一整个上海日的真实对话，用 Flash 抽成几条流水，逐条写回 vault。

```json
{ "id": "diary-rollup", "type": "diary-rollup" }
```

- 调度走上海墙钟，不走 `intervalMinutes` + jitter：要的是「每天 02:30 跑一次」，
  不是「大约每 24 小时一次」。`atHour` / `atMinute` 可配。
- `targetOffsetDays` 默认 1，即凌晨结算**前一天**。跑在当天 23:30 会漏掉后面那一截，
  跑在次日凌晨则整天已经封口。
- 数据来自网关的 `GET /api/journal/day?date=YYYY-MM-DD`，按 `date(created_at, '+8 hours')`
  切上海日，只取 DM 的 `done` 文本消息，排除 room、软删除、`uiHidden` 与 `sender=system`
  的自动触发消息。
- 判空在调模型之前：不足 `minMessages` / `minUserMessages` 的一天直接跳过，不烧钱。
- 抽取只认 `role=user` 的行（User 原话），AI 回复只作上下文。整批 JSON 严格校验，
  任何一条 time/text 不合法就整批拒绝重试——宁可不写，也不往她的日记里塞半截内容。
- 抽取最多跑 `extractAttempts` 次（默认 2）。首次 `temperature: 0` 求稳定复现；
  重试必须换采样（0.3 + 放宽 max_tokens），否则同 prompt + temperature 0 会原样再吐
  一遍同一份坏 JSON，重试等于白花钱。解析失败时报错里带原文前 500 字，
  下次是实锤而不是靠 `position` 猜成因。
- 每个上海日只结算一次：事件 dedupeKey 带日期，另有 `diary-rollup:<date>` 状态兜底，
  `thin` / `empty` 也落状态，重启不会重复结算或重复付费。
- 终点是 vault，不派给任何联系人，也不消耗 daily / idea / task 的额度。
  `/health` 暴露 `diaryPoolDispatched`、`diaryChecks`、`diaryNoops`、`diaryRollups`
  与 `lastDiaryRollupAt`。

补历史用 `diary-backfill.mjs`，跟每日 rollup 共用 `diary-rollup.mjs` 同一条链路：

```bash
node diary-backfill.mjs --from 2026-07-21 --to 2026-07-27 --dry-run
node diary-backfill.mjs --from 2026-07-21 --to 2026-07-27
```

`--dry-run` 打印将要写入的条目而不碰 vault。默认 `source` 是 `hub-rollup-backfill`
（每日 rollup 是 `hub-rollup`），日记里一眼能看出哪几条是事后重建的。默认拒绝结算
还没过完的今天，除非显式 `--force`。`diary.enabled` 只管定时源，不约束手工 backfill。

依赖：vault 的 `log_daily` 必须支持 `date` / `time` 两个可选参数，否则条目会全部
落到「今天此刻」。

Each routable contact may add:

```json
{
  "routing": {
    "enabled": true,
    "recipientKey": "engineering",
    "categories": ["file-change", "system"],
    "minPriority": 1,
    "dailyLimit": 10,
    "cooldownMinutes": 30,
    "fallback": false
  }
}
```

Copy `ai-hub-triage-worker.service` to systemd after adapting paths. Its sample
uses `/etc/ai-hub/triage.env` for secrets and `/var/lib/ai-hub-triage` for the
SQLite database. `/health` exposes the current NO_OP ratio, fallback count, cost,
per-recipient delivery distribution, and the separate daily/idea pool counters.

### Triage message origin

`HubClient.dispatch` 会把自动来源显式标为 `automated: true`，并保留来源、事件 id、分类和
优先级供审计。daily 主动陪伴照常使用 hidden main 触发并把自然回复送进主窗；普通
task/system triage 改由会议室 room-host 发 nudge，被点名成员在群轮次中选择 `[PASS]`、
登记观察或 `delegate_to_worker`。`[PASS]` 由群轮次原生静默；目标不是会议室成员时才带
「降级投递」前缀回退到可见 DM main。历史 side 行只作为审计与模型上下文保留。
