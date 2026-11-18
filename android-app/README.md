# Kedai Khanxa Android App (Kotlin + Jetpack Compose)

Proyek Android Native di folder `android-app/` terhubung **langsung & real-time** ke Firebase Project dan database Firestore yang sama dengan aplikasi Web Kedai Khanxa — **tanpa backend tambahan dan Rp0 biaya**.

- **Firebase Project ID:** `flash-lead-kwpgt`
- **Firestore Database ID:** `ai-studio-655beb1c-8e1a-4a3c-8e9c-6d8a3dcc3557`
- **Application ID default:** `com.kedaikhanxa.app`

---

## Fitur yang Sudah Tersedia di Versi Android

1. **Login Google & RBAC Otomatis (Admin / Kasir):**
   - Mendukung klaim undangan staf (`staff_invites`) dan penegakan peran `admin` vs `kasir` sesuai `firestore.rules`.
2. **Dashboard Operasional & Saldo Rekening Read-Only:**
   - Kasir melihat penjualan miliknya, riwayat closing miliknya, dan **saldo seluruh rekening usaha secara Hanya Baca** (tanpa HPP/Laba).
3. **POS Penjualan + Scan Barcode Kamera + Printer Bluetooth ESC/POS:**
   - Scan barcode on-device gratis via **CameraX + ML Kit**.
   - Cetak struk langsung ke printer thermal Bluetooth 58mm ter-pair tanpa dialog browser (tanpa menampilkan HPP/Laba ke Kasir).
4. **Mini ATM & PPOB:**
   - Pencatatan cepat dengan penyembunyian modal & laba bersih dari Kasir.
5. **Pelanggan & Piutang:**
   - Tambah pelanggan, edit profil (`nama`, `telepon`, `alamat`, `catatan`), dan pembayaran piutang.
6. **Closing Kasir & Hitung Uang Fisik:**
   - Pemisahan tunai vs non-tunai (*QRIS, Transfer Bank, Mini ATM, PPOB, Piutang*), input hitung fisik, deteksi otomatis *Balance / Short / Over*, finalisasi permanen untuk Kasir, dan verifikasi Admin.

---

## Langkah Build `.APK` di Android Studio (Gratis)

### 1. Buka Proyek di Android Studio
- Unduh proyek ini ke laptop/PC Anda.
- Buka **Android Studio**, pilih **Open**, lalu arahkan ke folder **`android-app/`**.
- Tunggu proses *Gradle Sync* selesai (memastikan koneksi internet lancar untuk mengunduh dependensi Jetpack Compose & Firebase Android SDK).

### 2. Ambil Sidik Jari SHA-1 & SHA-256
Agar Login Google (`Credential Manager` + Firebase Auth) berjalan di APK:
- Di terminal Android Studio (di dalam folder `android-app/`), jalankan:
  ```bash
  ./gradlew signingReport
  ```
- Salin nilai **SHA1** dan **SHA-256** pada blok `Variant: debug` (dan `release` jika membuat keystore rilis).

### 3. Daftarkan Aplikasi Android di Firebase Console & Pasang `google-services.json`
1. Buka Firebase Console untuk proyek **`flash-lead-kwpgt`**.
2. Masuk ke **Project Settings (ikon roda gigi) → Your apps → Add app → pilih Android**.
3. Masukkan Android package name: **`com.kedaikhanxa.app`**.
4. Masukkan **SHA-1** (dan **SHA-256** di Settings setelah aplikasi dibuat).
5. Unduh file **`google-services.json`** lalu salin persis ke:
   ```text
   android-app/app/google-services.json
   ```

### 4. Build File `.APK`
- Di Android Studio klik menu **Build → Build Bundle(s) / APK(s) → Build APK(s)**.
- Setelah selesai, klik **locate** untuk mengambil file `.apk` (`android-app/app/build/outputs/apk/debug/app-debug.apk`).
- Kirim file `.apk` tersebut ke HP Admin & HP Kasir lalu pasang (*Install*).

> **Catatan:** Karena container AI Studio Web hanya memiliki runtime Node.js/Vite (tanpa JDK/Gradle/Android SDK), proyek di `android-app/` belum dikompilasi di server dan baru dikompilasi melalui **GitHub Actions** (tanpa PC) atau **Android Studio** di PC.

---

## Langkah Build `.APK` Tanpa PC (Lewat Browser HP + GitHub Actions, Gratis Rp0)

Sudah tersedia dua workflow di `.github/workflows/`:
1. `generate-android-keystore.yml` — membuat keystore penanda tangan APK + mencetak **SHA-1 & SHA-256** tanpa perlu `keytool`/PC.
2. `build-android-apk.yml` — mengompilasi `android-app/` menggunakan Gradle 8.9 dan menghasilkan file `.apk` siap unduh di tab **Actions → Artifacts**.

### Urutan Langkah dari HP:
1. **Upload Proyek ke GitHub Private Repo:**
   - Buat repositori baru bertipe **Private** di GitHub (gratis), lalu upload isi proyek ini.
2. **Buat Keystore & Ambil SHA-1 / SHA-256:**
   - Buka tab **Actions** di GitHub → pilih **Generate Android Keystore (Tanpa PC)** → klik **Run workflow**.
   - Setelah selesai, buka ringkasan (*Summary*) run tersebut untuk menyalin **SHA-1** & **SHA-256**, lalu unduh artifact `khanxa-keystore-bundle` untuk mengambil isi `keystore_base64.txt`.
3. **Daftarkan Aplikasi Android di Firebase Console:**
   - Buka project **`flash-lead-kwpgt`** → **Project Settings → Add app (Android)**.
   - Isi package name **`com.kedaikhanxa.app`** beserta **SHA-1** dan **SHA-256** dari langkah 2.
   - Unduh file **`google-services.json`**.
4. **Simpan Secrets di GitHub:**
   - Di repo GitHub masuk ke **Settings → Secrets and variables → Actions → New repository secret**, lalu tambahkan:
     - `GOOGLE_SERVICES_JSON`: *(tempel seluruh isi file `google-services.json`)*
     - `KEYSTORE_BASE64`: *(isi teks `keystore_base64.txt`)*
     - `KEYSTORE_PASSWORD`: *(password dari ringkasan langkah 2)*
     - `KEY_ALIAS`: `kedaikhanxa` *(atau alias yang Anda pilih)*
     - `KEY_PASSWORD`: *(sama dengan `KEYSTORE_PASSWORD`)*
   - *(Demi keamanan, hapus history workflow run `Generate Android Keystore` setelah secrets tersimpan).*
5. **Compile & Unduh `.APK` di HP:**
   - Buka tab **Actions** → **Build Android APK (Kedai Khanxa)** → klik **Run workflow**.
   - Tunggu ~3–5 menit hingga centang hijau, lalu unduh file **`.apk`** di bagian **Artifacts** paling bawah halaman run dan pasang di HP Admin / Kasir.
