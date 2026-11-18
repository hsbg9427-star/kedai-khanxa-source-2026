#!/usr/bin/env bash
set -euo pipefail

PROD_PROJECT="${1:-flash-lead-kwpgt}"
OUT_DIR="${2:-./firebase-auth-rules-backup-$(date -u +%Y%m%d-%H%M%SZ)}"

mkdir -p "${OUT_DIR}"

echo "=== 1. Ekspor Firebase Authentication (${PROD_PROJECT}) ==="
firebase auth:export "${OUT_DIR}/auth-users.json" --format=json --project="${PROD_PROJECT}"

if [ -f "../firestore.rules" ]; then
  cp "../firestore.rules" "${OUT_DIR}/firestore.rules"
fi
if [ -f "../firebase-applet-config.json" ]; then
  cp "../firebase-applet-config.json" "${OUT_DIR}/firebase-applet-config.json"
fi
if [ -f "../firebase-blueprint.json" ]; then
  cp "../firebase-blueprint.json" "${OUT_DIR}/firebase-blueprint.json"
fi

(
  cd "${OUT_DIR}"
  sha256sum ./* > SHA256SUMS.txt
)

echo "=== BACKUP AUTH & RULES SELESAI ==="
echo "Lokasi output: ${OUT_DIR}"
echo "PERINGATAN KEAMANAN: auth-users.json berisi data akun & hash. Simpan privat, JANGAN upload ke repo publik."
