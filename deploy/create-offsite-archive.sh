#!/usr/bin/env bash
set -euo pipefail

repo="${AI_HUB_REPO:-/opt/ai-hub}"
tool="${AI_HUB_OFFSITE_TOOL:-$repo/deploy/offsite-backup.mjs}"
db="${AI_HUB_DB:-$repo/server/data/hub.db}"
uploads="${AI_HUB_UPLOADS:-$repo/server/data/uploads}"
output_root="${AI_HUB_OFFSITE_STAGING:-/var/backups/ai-hub/offsite}"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="ai-hub-offsite-$stamp"
bundle="$output_root/$name"
archive="$output_root/$name.tar.gz"
sha_file="$archive.sha256"

cleanup() {
  rm -rf -- "$bundle"
}
trap cleanup EXIT

mkdir -p "$output_root"
find "$output_root" -maxdepth 1 -type f -name 'ai-hub-offsite-*.tar.gz*' -mtime +7 -delete

commit="$(git -C "$repo" rev-parse HEAD)"
attempt=1
while true; do
  rm -rf -- "$bundle"
  if node "$tool" create \
    --db "$db" \
    --uploads "$uploads" \
    --output "$bundle" \
    --commit "$commit"; then
    break
  fi
  if (( attempt >= 3 )); then
    echo "offsite archive failed after $attempt attempts" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 1
done

tar -C "$output_root" -czf "$archive" "$name"
sha256sum "$archive" > "$sha_file"
chmod 600 "$archive" "$sha_file"

echo "ARCHIVE=$archive"
echo "SHA256=$sha_file"
