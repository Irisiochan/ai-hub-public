#!/usr/bin/env bash
set -euo pipefail

repo="${AI_HUB_DIR:-/opt/ai-hub}"
backup_dir="${AI_HUB_BACKUP_DIR:-/var/backups/ai-hub}"
release_dir="${AI_HUB_RELEASE_DIR:-/var/lib/ai-hub/releases}"
publish_status_file="${AI_HUB_APP_PUBLISH_STATUS_FILE:-/var/lib/ai-hub/app-publish-status.json}"
deploy_receipt_file="${AI_HUB_DEPLOY_RECEIPT:-/var/lib/ai-hub/deploy-receipt.json}"

cd "$repo"

echo "== deploy start $(date -u +%Y-%m-%dT%H:%M:%SZ) =="

# 每个 start 标记都必须配一个终止标记：网关靠「最后一个 start 后面有没有 ok/fail」
# 判断部署还在不在跑（routes/system.ts deployLogRunning），没有终止标记就会一直当作
# 在跑，会议室 drain 跟着卡到 30 分钟 stale 阈值才自己松开。2026-09-16 实测：工作区脏
# 被拒的早退路径没写标记，房间派发被白白 drain 了一轮。
terminator_written=0
on_exit() {
  local code=$?
  if [[ "$terminator_written" != 1 && $code -ne 0 ]]; then
    echo "== deploy fail (aborted before rollout, exit $code) ==" >&2
  fi
}
trap on_exit EXIT

dirty="$(git status --porcelain --untracked-files=all)"
if [[ -n "$dirty" ]]; then
  echo "Refusing to deploy: $repo has uncommitted changes." >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

write_deploy_receipt() {
  local current deployed_at deploy_id
  current="$(git rev-parse HEAD)"
  deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  deploy_id="deploy-${current:0:12}-$(date -u +%Y%m%dT%H%M%SZ)"
  DEPLOY_RECEIPT_FILE="$deploy_receipt_file" DEPLOY_COMMIT="$current" \
  DEPLOYED_AT="$deployed_at" DEPLOY_ID="$deploy_id" node <<'NODE'
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const file = process.env.DEPLOY_RECEIPT_FILE;
const reachableCommits = execFileSync('git', ['rev-list', '--max-count=10000', 'HEAD'], {
  encoding: 'utf8',
}).trim().split(/\r?\n/).filter(Boolean);
const payload = {
  deployId: process.env.DEPLOY_ID,
  commit: process.env.DEPLOY_COMMIT,
  deployedAt: process.env.DEPLOYED_AT,
  reachableCommits,
};
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
fs.renameSync(temp, file);
NODE
  if id -u ai-hub >/dev/null 2>&1; then
    chown ai-hub:ai-hub "$deploy_receipt_file"
  fi
  chmod 0644 "$deploy_receipt_file"
}

mkdir -p "$backup_dir"
if [[ -f server/config.json ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a server/config.json "$backup_dir/config.json.$stamp"
fi

prev="$(git rev-parse HEAD)"

git pull --ff-only

write_publish_status() {
  local branch current remote dirty
  branch="$(git branch --show-current)"
  current="$(git rev-parse HEAD)"
  remote="$(git rev-parse "refs/remotes/origin/${branch:-master}")"
  dirty=false
  [[ -z "$(git status --porcelain --untracked-files=all)" ]] || dirty=true
  PUBLISH_STATUS_FILE="$publish_status_file" \
  PUBLISH_BRANCH="${branch:-'(detached)'}" \
  PUBLISH_CURRENT="$current" \
  PUBLISH_REMOTE="$remote" \
  PUBLISH_DIRTY="$dirty" node <<'NODE'
const fs = require('fs');
const path = require('path');
const file = process.env.PUBLISH_STATUS_FILE;
const currentCommit = process.env.PUBLISH_CURRENT;
const remoteCommit = process.env.PUBLISH_REMOTE;
const payload = {
  available: true,
  branch: process.env.PUBLISH_BRANCH,
  currentCommit,
  remoteCommit,
  matchesRemote: currentCommit === remoteCommit,
  dirty: process.env.PUBLISH_DIRTY === 'true',
  generatedAt: new Date().toISOString(),
};
fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
const temp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(temp, `${JSON.stringify(payload)}\n`, { mode: 0o644 });
fs.renameSync(temp, file);
NODE
  chown ai-hub:ai-hub "$publish_status_file"
  chmod 0644 "$publish_status_file"
}

# npm ci is intentionally used here: deployment must consume the committed
# lockfiles without rewriting them on a different npm version.
# && 链式而非依赖 set -e：这个函数会在 if 条件里调用，set -e 在那种上下文不生效。
build_and_restart() {
  local web_version
  web_version="$(git rev-parse --short=12 HEAD)" &&
  npm ci --prefix server --no-audit --no-fund &&
    npm ci --prefix web --no-audit --no-fund &&
    npm run build --prefix server &&
    AI_HUB_WEB_VERSION="$web_version" npm run build --prefix web &&
    HUB_RELEASES_DIR="$release_dir" AI_HUB_WEB_VERSION="$web_version" node server/scripts/build-app-release.mjs &&
    { ! id -u ai-hub >/dev/null 2>&1 || write_publish_status; } &&
    { ! id -u ai-hub >/dev/null 2>&1 || chown -R ai-hub:ai-hub server/node_modules server/dist web/dist "$release_dir"; } &&
    # 部署单元的 UMask=0077 让 git pull 出来的源文件是 600 root:root，非 root 网关读不到。
    # 网关运行时会从检出里读 server/agents/<id>/ 下的人设与 overlay，也会在启动时
    # 读取 server/migrations/*.sql；triage 服务直接运行 worker/*.mjs。这里给这些运行时输入补回可读位。
    # 只放开跟踪源码，不碰 /opt/ai-hub/.env（未跟踪，保持 600）。
    chmod -R a+rX server/agents server/migrations worker shared/coordination-keys &&
    systemctl restart ai-hub &&
    systemctl restart ai-hub-triage-worker
}

health_url() {
  if [[ -n "${AI_HUB_HEALTH_URL:-}" ]]; then
    echo "$AI_HUB_HEALTH_URL"
    return
  fi
  AI_HUB_DIR="$repo" node -e '
    const path = require("path");
    let host = "127.0.0.1", port = 3900;
    try {
      const c = require(path.join(process.env.AI_HUB_DIR, "server", "config.json"));
      if (c.host) host = c.host;
      if (c.port) port = c.port;
    } catch {}
    process.stdout.write(`http://${host}:${port}/api/health`);
  ' 2>/dev/null || echo "http://127.0.0.1:3900/api/health"
}

wait_healthy() {
  local url
  url="$(health_url)"
  for _ in $(seq 1 15); do
    sleep 2
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      echo "health check ok: $url"
      return 0
    fi
  done
  echo "health check FAILED: $url" >&2
  return 1
}

if ! { build_and_restart && wait_healthy; }; then
  echo "== deploy failed, rolling back to $prev ==" >&2
  git reset --hard "$prev"
  if build_and_restart && wait_healthy; then
    echo "== deploy fail (rolled back to ${prev:0:7}, service healthy) ==" >&2
  else
    echo "== deploy fail (rollback ALSO unhealthy — manual intervention needed) ==" >&2
  fi
  terminator_written=1
  exit 1
fi

dirty="$(git status --porcelain --untracked-files=all)"
if [[ -n "$dirty" ]]; then
  echo "Deploy completed, but the checkout became dirty:" >&2
  printf '%s\n' "$dirty" >&2
  # 已经上线了，只是检出变脏：单独给一个终止标记，别让 trap 报成「上线前中止」。
  echo "== deploy fail (rolled out, but checkout became dirty) ==" >&2
  terminator_written=1
  exit 1
fi

git status -sb
write_deploy_receipt
terminator_written=1
echo "== deploy ok $(git rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%M:%SZ) =="

# W2: roll the vps-dev worker release forward to the deployed SHA.
# Switching-moment guarantees (no suicidal restart):
#   1. The deploy receipt above and the "== deploy ok ==" line are written
#      BEFORE this step, so deferral/failure here never blocks deploy evidence.
#   2. The installer checks for live worker children BEFORE flipping the
#      `current` symlink; with a child running (normally the deploy closure
#      job itself) it records a pending-release and exits 0 without restarting.
#   3. This call never passes --force, so the closure job survives to upload
#      its own receipt to the gateway.
#   4. A restart happens only when zero children exist — either right here
#      (idle worker) or later via ai-dev-worker-release.timer
#      (`install-vps-worker.sh --retry-pending`), i.e. strictly after the
#      closure job's receipt round-trip.
# A failure here never fails the deploy (it is already ok); it only prints a
# manual retry. Skip entirely with AI_HUB_SKIP_VPS_WORKER_FOLLOWUP=1.
if [ "${AI_HUB_SKIP_VPS_WORKER_FOLLOWUP:-}" != "1" ]; then
  installer_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" >/dev/null 2>&1 && pwd)"
  installer="${AI_HUB_INSTALL_VPS_WORKER:-$installer_dir/install-vps-worker.sh}"
  if [ -f "$installer" ]; then
    deployed_sha="$(git rev-parse HEAD)"
    if ! bash "$installer" "$deployed_sha"; then
      echo "vps worker release follow-up failed for $deployed_sha; deploy itself is ok — retry manually: sudo bash $installer $deployed_sha" >&2
    fi
  else
    echo "vps worker release follow-up skipped: installer not found at $installer" >&2
  fi
fi
