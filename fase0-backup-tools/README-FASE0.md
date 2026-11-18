# Tahap 0 — Backup Penuh & Uji Restore Proyek Terpisah (Kedai Khanxa)

## Target Produksi (Read-Only, TIDAK Diubah)
- `projectId`: `flash-lead-kwpgt`
- `firestoreDatabaseId`: `ai-studio-655beb1c-8e1a-4a3c-8e9c-6d8a3dcc3557`

## 1. Snapshot Lokal Kode Sumber, Konfigurasi & Security Rules
Sudah dijalankan di workspace via `./01-backup-local-source.sh`, menghasilkan arsip `.tar.gz`, salinan `.bak`, dan `SHA256SUMS.txt` di folder `backups/`. Unduh/simpan salinan folder tersebut ke penyimpanan luar (PC / Google Drive pribadi).

## 2. Backup Live Firestore & Firebase Auth di Google Cloud Shell (Gratis / Spark)
1. Buka `https://console.cloud.google.com/` dengan akun Google pemilik proyek (`hsbg9427@gmail.com`).
2. Unggah folder `fase0-backup-tools/` beserta salinan `firestore.rules`, `firebase-applet-config.json`, `firebase-blueprint.json` di direktori induknya.
3. Jalankan:
```bash
cd fase0-backup-tools
npm install
gcloud auth application-default login
firebase login --no-localhost

chmod +x 05-cloudshell-auth-and-rules-backup.sh
./05-cloudshell-auth-and-rules-backup.sh flash-lead-kwpgt ./backup-auth-rules

node 02-firestore-full-backup.mjs \
  --project flash-lead-kwpgt \
  --database ai-studio-655beb1c-8e1a-4a3c-8e9c-6d8a3dcc3557 \
  --out ./backup-firestore-prod
```

## 3. Uji Restore & Verifikasi Diff 100% di Proyek Firebase Terpisah
1. Buat 1 proyek Firebase baru yang masih kosong (paket Spark gratis) di Firebase Console, aktifkan Firestore `(default)` dan Google Sign-In Auth.
2. Jalankan dry-run, restore, dan verifikasi diff:
```bash
node 03-firestore-restore.mjs --backup-dir ./backup-firestore-prod --project <ID_PROYEK_UJI> --database "(default)" --dry-run
node 03-firestore-restore.mjs --backup-dir ./backup-firestore-prod --project <ID_PROYEK_UJI> --database "(default)"
node 04-verify-restore-diff.mjs --backup-dir ./backup-firestore-prod --project <ID_PROYEK_UJI> --database "(default)"
```
3. Pastikan output berakhir dengan `STATUS : LULUS 100% COCOK`.
4. Uji restore `firestore.rules` dan Auth di proyek uji:
```bash
# Di folder sementara khusus proyek uji (bukan produksi):
firebase deploy --only firestore:rules --project <ID_PROYEK_UJI>
firebase auth:import ./backup-auth-rules/auth-users.json --project <ID_PROYEK_UJI>
```
