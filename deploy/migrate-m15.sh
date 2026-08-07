#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "M1.5 migration must run as root." >&2
  exit 1
fi

repo="${AI_HUB_DIR:-/opt/ai-hub}"
vault_repo="${MEMORY_VAULT_DIR:-/opt/memory-vault}"
backup_root="${AI_HUB_BACKUP_DIR:-/var/backups/ai-hub}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${AI_HUB_M15_BACKUP_DIR:-/var/backups/ai-hub-m15}/$stamp"
token_file="${HARDENING_TOKEN_FILE:-/run/ai-hub-m15-hub-token}"
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"

backup_if_exists() {
  local source="$1" name="$2"
  [[ ! -e "$source" ]] || cp -a "$source" "$backup_dir/$name"
}

backup_if_exists /etc/systemd/system/ai-hub.service ai-hub.service
backup_if_exists /etc/systemd/system/memory-vault-mcp.service memory-vault-mcp.service
backup_if_exists /etc/systemd/system/ai-hub-update.path ai-hub-update.path
backup_if_exists /etc/systemd/system/ai-hub-update.service ai-hub-update.service
backup_if_exists "$repo/.env" ai-hub.env
backup_if_exists /etc/ai-hub/triage.env triage.env
backup_if_exists "$repo/server/config.json" server-config.json
if [[ -d /etc/systemd/system/memory-vault-mcp-public.service.d ]]; then
  cp -a /etc/systemd/system/memory-vault-mcp-public.service.d "$backup_dir/memory-vault-mcp-public.service.d"
fi

rollback() {
  local code=$?
  trap - ERR
  rm -f "$token_file"
  echo "M1.5 migration failed; restoring service units and secret files." >&2
  [[ ! -f "$backup_dir/ai-hub.service" ]] || cp -a "$backup_dir/ai-hub.service" /etc/systemd/system/ai-hub.service
  [[ ! -f "$backup_dir/memory-vault-mcp.service" ]] || cp -a "$backup_dir/memory-vault-mcp.service" /etc/systemd/system/memory-vault-mcp.service
  [[ ! -f "$backup_dir/ai-hub.env" ]] || cp -a "$backup_dir/ai-hub.env" "$repo/.env"
  [[ ! -f "$backup_dir/triage.env" ]] || cp -a "$backup_dir/triage.env" /etc/ai-hub/triage.env
  [[ ! -f "$backup_dir/server-config.json" ]] || cp -a "$backup_dir/server-config.json" "$repo/server/config.json"
  if [[ -f "$backup_dir/ai-hub-update.path" ]]; then
    cp -a "$backup_dir/ai-hub-update.path" /etc/systemd/system/ai-hub-update.path
  else
    rm -f /etc/systemd/system/ai-hub-update.path
  fi
  if [[ -f "$backup_dir/ai-hub-update.service" ]]; then
    cp -a "$backup_dir/ai-hub-update.service" /etc/systemd/system/ai-hub-update.service
  else
    rm -f /etc/systemd/system/ai-hub-update.service
  fi
  if [[ -d "$backup_dir/memory-vault-mcp-public.service.d" ]]; then
    install -d -m 0755 -o root -g root /etc/systemd/system/memory-vault-mcp-public.service.d
    cp -a "$backup_dir/memory-vault-mcp-public.service.d/." /etc/systemd/system/memory-vault-mcp-public.service.d/
  else
    rm -f /etc/systemd/system/memory-vault-mcp-public.service.d/m15-hardening.conf
  fi
  systemctl daemon-reload || true
  systemctl disable --now ai-hub-update.path >/dev/null 2>&1 || true
  systemctl restart memory-vault-mcp ai-hub ai-hub-triage-worker || true
  exit "$code"
}
trap rollback ERR

if [[ -n "$(git -c safe.directory="$vault_repo" -C "$vault_repo" status --porcelain --untracked-files=all)" ]]; then
  echo "Refusing M1.5 migration: $vault_repo has uncommitted changes." >&2
  exit 1
fi
git -c safe.directory="$vault_repo" -C "$vault_repo" pull --ff-only

id -u ai-hub >/dev/null 2>&1 || useradd --system --home-dir /var/lib/ai-hub/home --shell /usr/sbin/nologin --no-create-home ai-hub
id -u memory-vault >/dev/null 2>&1 || useradd --system --home-dir /var/lib/memory-vault/home --shell /usr/sbin/nologin --no-create-home memory-vault

install -d -m 0700 -o ai-hub -g ai-hub /var/lib/ai-hub /var/lib/ai-hub/home /var/lib/ai-hub/home/.local /var/lib/ai-hub/home/.local/bin
install -d -m 0700 -o memory-vault -g memory-vault /var/lib/memory-vault /var/lib/memory-vault/home /var/lib/memory-vault/home/.ssh
install -d -m 0750 -o ai-hub -g ai-hub "$repo/server/data" "$backup_root"
install -d -m 0755 -o root -g root /etc/ai-hub

copy_home_dir_once() {
  local source="$1" destination="$2" owner="$3"
  [[ ! -d "$source" || -e "$destination" ]] || cp -a "$source" "$destination"
  [[ ! -e "$destination" ]] || chown -R "$owner:$owner" "$destination"
}
copy_home_dir_once /root/.claude /var/lib/ai-hub/home/.claude ai-hub
copy_home_dir_once /root/.codex /var/lib/ai-hub/home/.codex ai-hub
copy_home_dir_once /root/.grok /var/lib/ai-hub/home/.grok ai-hub
if [[ -f /root/.claude.json && ! -e /var/lib/ai-hub/home/.claude.json ]]; then
  install -m 0600 -o ai-hub -g ai-hub /root/.claude.json /var/lib/ai-hub/home/.claude.json
fi

for cli in claude grok; do
  if [[ -x "/root/.local/bin/$cli" ]]; then
    install -m 0755 -o root -g root "/root/.local/bin/$cli" "/var/lib/ai-hub/home/.local/bin/$cli"
  fi
done

AI_HUB_CONFIG="$repo/server/config.json" node - <<'NODE'
const fs = require('fs');
const file = process.env.AI_HUB_CONFIG;
if (!file || !fs.existsSync(file)) process.exit(0);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const replacements = {
  '/root/.local/bin/claude': '/var/lib/ai-hub/home/.local/bin/claude',
  '/root/.local/bin/grok': '/var/lib/ai-hub/home/.local/bin/grok',
};
for (const key of ['claude', 'grok']) {
  const current = config[key]?.cliPath;
  if (typeof current === 'string' && replacements[current]) config[key].cliPath = replacements[current];
}
const temp = `${file}.m15-tmp`;
fs.writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o644 });
fs.renameSync(temp, file);
NODE
if [[ -f "$repo/server/config.json" ]]; then
  chown root:root "$repo/server/config.json"
  chmod 0644 "$repo/server/config.json"
fi

if [[ -f /root/.ssh/vault_deploy ]]; then
  install -m 0600 -o memory-vault -g memory-vault /root/.ssh/vault_deploy /var/lib/memory-vault/home/.ssh/vault_deploy
fi
if [[ -f /root/.ssh/vault_deploy.pub ]]; then
  install -m 0644 -o memory-vault -g memory-vault /root/.ssh/vault_deploy.pub /var/lib/memory-vault/home/.ssh/vault_deploy.pub
fi
if [[ -f /root/.ssh/known_hosts ]]; then
  install -m 0644 -o memory-vault -g memory-vault /root/.ssh/known_hosts /var/lib/memory-vault/home/.ssh/known_hosts
fi
cat > /var/lib/memory-vault/home/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/vault_deploy
  IdentitiesOnly yes
EOF
chown memory-vault:memory-vault /var/lib/memory-vault/home/.ssh/config
chmod 600 /var/lib/memory-vault/home/.ssh/config

env_value() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s/^${key}=//p" "$file" | tail -n 1
}

upsert_env() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  if [[ -f "$file" ]]; then
    awk -v key="$key" -v value="$value" '
      BEGIN { done = 0 }
      $0 ~ ("^" key "=") { if (!done) print key "=" value; done = 1; next }
      { print }
      END { if (!done) print key "=" value }
    ' "$file" > "$tmp"
  else
    printf '%s=%s\n' "$key" "$value" > "$tmp"
  fi
  install -m 0600 -o root -g root "$tmp" "$file"
  rm -f "$tmp"
}

if [[ -s "$token_file" ]]; then
  hub_token="$(tr -d '\r\n' < "$token_file")"
  rm -f "$token_file"
else
  hub_token="$(env_value "$repo/.env" HUB_TOKEN)"
  [[ -n "$hub_token" ]] || hub_token="$(env_value /etc/ai-hub/triage.env HUB_TOKEN)"
fi
if [[ ${#hub_token} -lt 32 || ${#hub_token} -gt 512 ]]; then
  echo "No valid bootstrap HUB_TOKEN was supplied; refusing to enable login." >&2
  exit 1
fi
upsert_env "$repo/.env" HUB_TOKEN "$hub_token"
upsert_env /etc/ai-hub/triage.env HUB_TOKEN "$hub_token"

systemctl stop ai-hub ai-hub-triage-worker memory-vault-mcp
chown -R ai-hub:ai-hub "$repo/server/data" /var/lib/ai-hub "$backup_root"
chown -R memory-vault:memory-vault "$vault_repo" /var/lib/memory-vault

install -m 0644 -o root -g root "$repo/deploy/ai-hub.service" /etc/systemd/system/ai-hub.service
install -m 0644 -o root -g root "$repo/deploy/ai-hub-update.path" /etc/systemd/system/ai-hub-update.path
install -m 0644 -o root -g root "$repo/deploy/ai-hub-update.service" /etc/systemd/system/ai-hub-update.service
install -m 0644 -o root -g root "$vault_repo/_meta/deploy/memory-vault-mcp.service" /etc/systemd/system/memory-vault-mcp.service
if systemctl cat memory-vault-mcp-public.service >/dev/null 2>&1; then
  install -d -m 0755 -o root -g root /etc/systemd/system/memory-vault-mcp-public.service.d
  install -m 0644 -o root -g root "$vault_repo/_meta/deploy/memory-vault-mcp-hardening.conf" \
    /etc/systemd/system/memory-vault-mcp-public.service.d/m15-hardening.conf
fi

systemctl daemon-reload
systemctl enable --now ai-hub-update.path
systemctl restart memory-vault-mcp ai-hub ai-hub-triage-worker
if systemctl cat memory-vault-mcp-public.service >/dev/null 2>&1; then
  systemctl restart memory-vault-mcp-public
fi

[[ "$(systemctl show -p User --value ai-hub)" == "ai-hub" ]]
[[ "$(systemctl show -p User --value memory-vault-mcp)" == "memory-vault" ]]
systemctl is-active --quiet ai-hub memory-vault-mcp ai-hub-triage-worker ai-hub-update.path
if systemctl cat memory-vault-mcp-public.service >/dev/null 2>&1; then
  [[ "$(systemctl show -p User --value memory-vault-mcp-public)" == "memory-vault" ]]
  systemctl is-active --quiet memory-vault-mcp-public
fi

hub_url="$(AI_HUB_DIR="$repo" node - <<'NODE'
const path = require('path');
const config = require(path.join(process.env.AI_HUB_DIR, 'server', 'config.json'));
process.stdout.write(`http://${config.host || '127.0.0.1'}:${config.port || 3900}`);
NODE
)"
hub_ready=false
for _ in $(seq 1 15); do
  if curl -fsS --max-time 3 "$hub_url/api/health" >/dev/null 2>&1; then
    hub_ready=true
    break
  fi
  sleep 2
done
if [[ "$hub_ready" != true ]]; then
  echo "Hardened ai-hub did not become healthy within 30 seconds." >&2
  exit 1
fi
[[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$hub_url/api/contacts")" == "401" ]]
curl -fsS --max-time 5 -H "Authorization: Bearer $hub_token" "$hub_url/api/contacts" >/dev/null
login_body="$(HUB_LOGIN_PASSWORD="$hub_token" node -e 'process.stdout.write(JSON.stringify({password: process.env.HUB_LOGIN_PASSWORD}))')"
login_result="$(printf '%s' "$login_body" | curl -fsS --max-time 5 -H 'Content-Type: application/json' --data-binary @- "$hub_url/api/session")"
LOGIN_RESULT="$login_result" node -e '
  const result = JSON.parse(process.env.LOGIN_RESULT || "{}");
  if (result.authenticated !== true || typeof result.sessionToken !== "string" || !result.sessionToken.startsWith("v1.")) process.exit(1);
'

runuser -u ai-hub -- env HOME=/var/lib/ai-hub/home PATH=/var/lib/ai-hub/home/.local/bin:/usr/local/bin:/usr/bin claude --version >/dev/null
runuser -u ai-hub -- env HOME=/var/lib/ai-hub/home PATH=/var/lib/ai-hub/home/.local/bin:/usr/local/bin:/usr/bin codex --version >/dev/null
runuser -u ai-hub -- env HOME=/var/lib/ai-hub/home PATH=/var/lib/ai-hub/home/.local/bin:/usr/local/bin:/usr/bin grok --version >/dev/null
[[ -z "$(runuser -u memory-vault -- env HOME=/var/lib/memory-vault/home git -C "$vault_repo" status --short)" ]]
# Read-only remote probe proves the migrated deploy key is usable by the new
# service account; it does not fetch, merge, commit, or push.
runuser -u memory-vault -- env HOME=/var/lib/memory-vault/home \
  git -C "$vault_repo" ls-remote --exit-code origin HEAD >/dev/null

trap - ERR
echo "M1.5 migration ok: services are non-root, session auth is enabled, and the root deployment watcher is active."
echo "Rollback snapshot: $backup_dir"
