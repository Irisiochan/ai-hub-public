#!/usr/bin/env bash
# Install a reviewed ai-hub commit as the vps-dev worker release, then restart.
#
# Run as root ON THE VPS:
#   sudo bash /opt/ai-hub/deploy/install-vps-worker.sh <sha>
#   sudo bash /opt/ai-hub/deploy/install-vps-worker.sh <sha> --force   # restart even if a runner is active
#   sudo bash /opt/ai-hub/deploy/install-vps-worker.sh --retry-pending # install a deferred pending-release (timer path)
#
# Busy worker, no --force: the switch is DEFERRED, not refused — the pending
# sha is recorded in $PENDING_FILE and the script exits 0. deploy/update.sh
# relies on this: it calls this script after "== deploy ok ==" without
# --force, so the deploy closure job (a live child of the worker) is never
# killed before it uploads its receipt. ai-dev-worker-release.timer retries
# --retry-pending until the worker is idle.
#
# Layout (read-only, root-owned; exactly one version is live at a time):
#   /opt/ai-hub-worker/<sha12>/{worker,shared,deploy}
#   /opt/ai-hub-worker/current -> /opt/ai-hub-worker/<sha12>
#
# deploy/ MUST ship with the worker: the merge/deploy closure gate scripts are
# resolved from this release tree (worker/closure-runner.mjs
# resolveClosureScript), never from the job workspace they judge. A release
# without deploy/ fails every closure closed.
#
# The unit is installed from the SAME release, so worker code and its sandbox
# policy never drift apart. Any local drop-in is reported, not deleted: remove
# it only after checking every directive it sets is in the new unit.
set -euo pipefail

SRC_REPO=${SRC_REPO:-/opt/ai-hub}
ROOT=${ROOT:-/opt/ai-hub-worker}
UNIT_NAME=ai-dev-worker.service
UNIT_DST=${UNIT_DST:-/etc/systemd/system/$UNIT_NAME}
UNIT_DROPIN_DIR=${UNIT_DROPIN_DIR:-/etc/systemd/system/$UNIT_NAME.d}
# Pending-release record: written when the worker is busy instead of
# restarting under a live runner. Root-owned installer and the ai-dev worker
# both read it; the root retry path (ai-dev-worker-release.timer or a manual
# --retry-pending) consumes it. It lives in the worker StateDirectory so no
# sandbox/unit path change is needed to share it.
PENDING_FILE=${PENDING_FILE:-/var/lib/ai-dev-worker/pending-release.json}

# Test hooks (unset on the VPS; only set by automated tests):
#   INSTALL_VPS_WORKER_FAKE_BUSY=1|0  force busy/idle instead of pgrep
#   INSTALL_VPS_WORKER_NO_SYSTEMD=1   print DRYRUN lines, skip systemctl/journalctl/sleep
#   INSTALL_VPS_WORKER_ALLOW_NONROOT=1  skip the root check
retry_pending=0
if [ "${1:-}" = "--retry-pending" ]; then
  retry_pending=1
  force=${2:-}
  if [ ! -f "$PENDING_FILE" ]; then
    echo "NO_PENDING"
    exit 0
  fi
  ref=$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-fA-F]*\)".*/\1/p' "$PENDING_FILE" | head -n 1)
  [ -n "$ref" ] || { echo "pending file $PENDING_FILE has no sha; leaving it for inspection" >&2; exit 1; }
else
  ref=${1:-}
  force=${2:-}
  [ -n "$ref" ] || { echo "usage: $0 <sha> [--force] | $0 --retry-pending [--force]" >&2; exit 2; }
fi
if [ "${INSTALL_VPS_WORKER_ALLOW_NONROOT:-}" != "1" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
fi

# Resolve against the deployed gateway checkout: it only contains what the
# normal deploy channel already fetched, i.e. reviewed master history.
sha=$(git -C "$SRC_REPO" rev-parse --verify --quiet "${ref}^{commit}") \
  || { echo "cannot resolve $ref in $SRC_REPO (deploy it first)" >&2; exit 1; }
if ! git -C "$SRC_REPO" merge-base --is-ancestor "$sha" origin/master 2>/dev/null; then
  echo "refusing: $sha is not on origin/master in $SRC_REPO" >&2
  exit 1
fi
short=${sha:0:12}
dest=$ROOT/$short

# Busy check: the deploy closure job itself is normally a live child of the
# worker at this point, so a restart here would kill the job before it writes
# its receipt back to the gateway. Never restart under a live tree unless
# --force was passed explicitly by an operator (update.sh never passes it).
worker_busy() {
  if [ "${INSTALL_VPS_WORKER_FAKE_BUSY:-}" = "1" ]; then return 0; fi
  if [ "${INSTALL_VPS_WORKER_FAKE_BUSY:-}" = "0" ]; then return 1; fi
  main_pid=$(systemctl show -p MainPID --value "$UNIT_NAME" 2>/dev/null || echo 0)
  [ "${main_pid:-0}" -gt 0 ] && pgrep -P "$main_pid" >/dev/null 2>&1
}

run_systemctl() {
  if [ "${INSTALL_VPS_WORKER_NO_SYSTEMD:-}" = "1" ]; then echo "DRYRUN systemctl $*"; return 0; fi
  systemctl "$@"
}

unit_active_state() {
  if [ "${INSTALL_VPS_WORKER_NO_SYSTEMD:-}" = "1" ]; then echo "active"; return 0; fi
  systemctl is-active "$UNIT_NAME" || true
}

unit_restart_count() {
  if [ "${INSTALL_VPS_WORKER_NO_SYSTEMD:-}" = "1" ]; then echo "0"; return 0; fi
  systemctl show -p NRestarts --value "$UNIT_NAME"
}

# Deferred switch record: atomic write + world-readable so the ai-dev worker
# can report pendingReleaseSha in its heartbeat capabilities.
record_pending() {
  pending_dir="$(dirname "$PENDING_FILE")"
  mkdir -p "$pending_dir"
  tmp="$PENDING_FILE.tmp-$$"
  printf '{"sha":"%s","short":"%s","requestedAt":"%s","requestedBy":"install-vps-worker.sh","reason":"worker-busy"}\n' \
    "$1" "${1:0:12}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$tmp"
  mv -f "$tmp" "$PENDING_FILE"
  chmod 0644 "$PENDING_FILE"
  if id ai-dev >/dev/null 2>&1; then chown ai-dev:ai-dev "$PENDING_FILE" 2>/dev/null || true; fi
}

clear_pending() {
  [ -f "$PENDING_FILE" ] || return 0
  rm -f "$PENDING_FILE"
  echo "PENDING_CLEARED $1"
}

# Refuse to cut an active runner in half unless told to: defer to a pending
# record instead. Exit 0 — deferral is a handled outcome (the deploy that
# triggered this is already ok; the timer/manual --retry-pending finishes the
# switch when the worker goes idle).
if worker_busy && [ "$force" != "--force" ]; then
  record_pending "$sha"
  echo "deferred: $UNIT_NAME has a running child; recorded pending ${sha:0:12} in $PENDING_FILE" >&2
  echo "retry when idle: bash $0 --retry-pending (or wait for ai-dev-worker-release.timer)" >&2
  echo "PENDING $ROOT/${sha:0:12}"
  exit 0
fi

if [ ! -f "$dest/worker/worker.mjs" ]; then
  tmp=$(mktemp -d "$ROOT/.install-$short.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  git -C "$SRC_REPO" archive --format=tar "$sha" worker shared deploy | tar -x -C "$tmp"
  for required in worker/worker.mjs worker/$UNIT_NAME deploy/merge-close-job.mjs deploy/room-deploy-job.mjs; do
    [ -f "$tmp/$required" ] || { echo "release export is missing $required" >&2; exit 1; }
  done
  if [ "$(id -u)" -eq 0 ]; then chown -R root:root "$tmp"; fi
  find "$tmp" -type d -exec chmod 755 {} +
  find "$tmp" -type f -exec chmod 644 {} +
  chmod 755 "$tmp"
  mv "$tmp" "$dest"
  trap - EXIT
  echo "EXPORTED $dest"
else
  echo "REUSED $dest"
fi

# Unit from the same release.
UNIT_BACKUP_DIR=${UNIT_BACKUP_DIR:-/var/backups}
if ! cmp -s "$dest/worker/$UNIT_NAME" "$UNIT_DST" 2>/dev/null; then
  if [ -f "$UNIT_DST" ] && [ -d "$UNIT_BACKUP_DIR" ] && [ -w "$UNIT_BACKUP_DIR" ]; then
    cp -a "$UNIT_DST" "$UNIT_BACKUP_DIR/$UNIT_NAME.pre-$short"
  fi
  if [ "$(id -u)" -eq 0 ]; then
    install -m 644 -o root -g root "$dest/worker/$UNIT_NAME" "$UNIT_DST"
  else
    install -m 644 "$dest/worker/$UNIT_NAME" "$UNIT_DST"
  fi
  echo "UNIT_UPDATED"
fi
if [ -d "$UNIT_DROPIN_DIR" ]; then
  echo "NOTE drop-ins present in $UNIT_DROPIN_DIR — check each directive is in the new unit before removing:" >&2
  ls -1 "$UNIT_DROPIN_DIR" >&2
fi

prev=$(readlink -f "$ROOT/current" 2>/dev/null || true)
ln -sfn "$dest" "$ROOT/current.new"
mv -T "$ROOT/current.new" "$ROOT/current"
echo "CURRENT $prev -> $dest"

run_systemctl daemon-reload
run_systemctl restart "$UNIT_NAME"
if [ "${INSTALL_VPS_WORKER_NO_SYSTEMD:-}" != "1" ]; then sleep 5; fi
state=$(unit_active_state)
restarts=$(unit_restart_count)
echo "ACTIVE=$state NRESTARTS=$restarts"
if [ "$state" != "active" ]; then
  echo "worker did not come up; rolling current back to $prev" >&2
  [ -n "$prev" ] && ln -sfn "$prev" "$ROOT/current" && run_systemctl restart "$UNIT_NAME"
  exit 1
fi
# The switch landed: any pending record is now satisfied, whatever sha it
# held. Clear unconditionally — a stale entry for a different sha must not
# survive to roll `current` backwards on the next --retry-pending.
clear_pending "$sha"
if [ "${INSTALL_VPS_WORKER_NO_SYSTEMD:-}" != "1" ]; then journalctl -u "$UNIT_NAME" -n 3 --no-pager; fi
