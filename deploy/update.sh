#!/usr/bin/env bash
set -euo pipefail

repo="${AI_HUB_DIR:-/opt/ai-hub}"
backup_dir="${AI_HUB_BACKUP_DIR:-/var/backups/ai-hub}"
release_dir="${AI_HUB_RELEASE_DIR:-/var/lib/ai-hub/releases}"
publish_status_file="${AI_HUB_APP_PUBLISH_STATUS_FILE:-/var/lib/ai-hub/app-publish-status.json}"
deploy_receipt_file="${AI_HUB_DEPLOY_RECEIPT:-/var/lib/ai-hub/deploy-receipt.json}"

cd "$repo"

echo "== deploy start $(date -u +%Y-%m-%dT%H:%M:%SZ) =="

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
    chmod -R a+rX server/agents server/migrations worker &&
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
  exit 1
fi

dirty="$(git status --porcelain --untracked-files=all)"
if [[ -n "$dirty" ]]; then
  echo "Deploy completed, but the checkout became dirty:" >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

git status -sb
write_deploy_receipt
echo "== deploy ok $(git rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
