#!/usr/bin/env bash
set -euo pipefail

repo="${AI_HUB_DIR:-/opt/ai-hub}"
backup_dir="${AI_HUB_BACKUP_DIR:-/var/backups/ai-hub}"

cd "$repo"

echo "== deploy start $(date -u +%Y-%m-%dT%H:%M:%SZ) =="

dirty="$(git status --porcelain --untracked-files=all)"
if [[ -n "$dirty" ]]; then
  echo "Refusing to deploy: $repo has uncommitted changes." >&2
  printf '%s\n' "$dirty" >&2
  exit 1
fi

mkdir -p "$backup_dir"
if [[ -f server/config.json ]]; then
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  cp -a server/config.json "$backup_dir/config.json.$stamp"
fi

prev="$(git rev-parse HEAD)"

git pull --ff-only

# npm ci is intentionally used here: deployment must consume the committed
# lockfiles without rewriting them on a different npm version.
# && 链式而非依赖 set -e：这个函数会在 if 条件里调用，set -e 在那种上下文不生效。
build_and_restart() {
  npm ci --prefix server --no-audit --no-fund &&
    npm ci --prefix web --no-audit --no-fund &&
    npm run build --prefix server &&
    npm run build --prefix web &&
    systemctl restart ai-hub
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
echo "== deploy ok $(git rev-parse --short HEAD) $(date -u +%Y-%m-%dT%H:%M:%SZ) =="
