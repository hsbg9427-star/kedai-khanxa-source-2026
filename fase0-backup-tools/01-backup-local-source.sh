#!/usr/bin/env bash
set -euo pipefail

# Membuat snapshot terpisah kode sumber web, konfigurasi Firebase, package.json, bun.lock, dan firestore.rules
# TANPA mengubah file kerja web app yang ada.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TIMESTAMP="$(date -u +%Y%m%d-%H%M%SZ)"
BACKUP_BASE="${1:-${PROJECT_ROOT}/backups/fase0-source-${TIMESTAMP}}"

mkdir -p "${BACKUP_BASE}"

ARCHIVE_PATH="${BACKUP_BASE}/kedai-khanxa-source-${TIMESTAMP}.tar.gz"

tar \
  --exclude="./node_modules" \
  --exclude="./dist" \
  --exclude="./backups" \
  --exclude="./fase0-backup-tools" \
  --exclude="./.git" \
  -czf "${ARCHIVE_PATH}" \
  -C "${PROJECT_ROOT}" .

cp "${PROJECT_ROOT}/firestore.rules" "${BACKUP_BASE}/firestore.rules.bak"
cp "${PROJECT_ROOT}/firebase-applet-config.json" "${BACKUP_BASE}/firebase-applet-config.json.bak"
cp "${PROJECT_ROOT}/firebase-blueprint.json" "${BACKUP_BASE}/firebase-blueprint.json.bak"
cp "${PROJECT_ROOT}/package.json" "${BACKUP_BASE}/package.json.bak"
if [ -f "${PROJECT_ROOT}/bun.lock" ]; then
  cp "${PROJECT_ROOT}/bun.lock" "${BACKUP_BASE}/bun.lock.bak"
fi
if [ -f "${PROJECT_ROOT}/security_spec.md" ]; then
  cp "${PROJECT_ROOT}/security_spec.md" "${BACKUP_BASE}/security_spec.md.bak"
fi

(
  cd "${BACKUP_BASE}"
  sha256sum *.tar.gz *.bak > SHA256SUMS.txt
)

echo "=== SNAPSHOT LOKAL TAHAP 0 SELESAI ==="
echo "Folder backup : ${BACKUP_BASE}"
echo "Arsip kode    : ${ARCHIVE_PATH}"
echo "Checksum      : ${BACKUP_BASE}/SHA256SUMS.txt"
