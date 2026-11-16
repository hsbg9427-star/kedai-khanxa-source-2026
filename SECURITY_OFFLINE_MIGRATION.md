# Rencana Migrasi Keamanan Firestore — Kedai Khanxa

Status: rancangan migrasi, belum mengubah perilaku aplikasi atau aturan produksi.

## Tujuan

- Kasir tetap dapat membuat transaksi ketika perangkat offline.
- Transaksi offline disimpan dalam antrean lokal dengan ID idempoten.
- Server memvalidasi transaksi sebelum mengubah stok, saldo, piutang, dan buku kas.
- Owner dapat memantau transaksi tersinkron dan transaksi yang masih tertunda dari perangkat kedua.
- Riwayat transaksi keuangan dan stok bersifat append-only; koreksi dilakukan melalui transaksi pembalik.

## Temuan pada implementasi saat ini

1. `src/firebase.ts` mengaktifkan persistent local cache Firestore bila tersedia. Cache Firestore membantu operasi offline, tetapi belum menjadi antrean bisnis dengan status konflik dan hasil validasi server.
2. `recordRetailSale` di `src/services/inventoryService.ts` membuat satu `writeBatch` untuk penjualan, item, pergerakan stok, perubahan stok produk, saldo akun, ledger, dan piutang. Saat offline, batch tersebut diantrekan oleh SDK.
3. Aturan `firestore.rules` saat ini mengizinkan kasir menurunkan stok produk secara langsung, memperbarui saldo akun, dan membatalkan penjualan miliknya hanya dengan mengubah status. Aturan belum mewajibkan proses pembalikan stok dan keuangan.
4. Karena aplikasi sekarang menulis beberapa dokumen langsung dari klien, menutup akses tersebut sebelum jalur backend tersedia akan memutus fungsi kasir yang sedang berjalan.

## Kebijakan keamanan target

- Klien kasir tidak boleh menulis langsung ke `products.stock`, `accounts.balance`, atau mengubah status penjualan menjadi void.
- Klien mengirim perintah transaksi dengan `transactionId` unik, `deviceId`, identitas kasir, waktu lokal, detail barang, satuan, harga yang ditampilkan, pembayaran, dan informasi piutang.
- Backend memverifikasi identitas dan status staf, membaca ulang harga/konversi/stok dari server, menghitung ulang total, HPP, diskon, dan pembayaran, lalu menyimpan semua dampak transaksi secara atomik.
- Backend mencatat hasil idempoten berdasarkan `transactionId`; pengiriman ulang tidak boleh membuat penjualan kedua.
- Pembatalan dan retur dibuat sebagai dokumen pembalik yang mereferensikan transaksi asal; dokumen asli tidak dihapus atau ditimpa.
- Aturan Firestore memberi akses baca sesuai peran, menolak penulisan langsung klien pada saldo/stok final, dan hanya menerima dokumen hasil proses backend melalui pola otorisasi server yang sesuai.

## Rencana antrean offline

Status minimal: `queued`, `syncing`, `synced`, `needs_review`, `rejected`.

- Simpan payload antrean secara persisten di perangkat.
- Kirim berurutan ketika koneksi kembali.
- Gunakan `transactionId` sebagai kunci idempotensi.
- Tampilkan status pending dengan jelas; jangan menyebut transaksi sudah final sebelum server mengonfirmasi.
- Jika stok berubah, produk nonaktif, harga/konversi berubah, atau pelanggan tidak valid, tandai `needs_review` / `rejected` dan jangan menerapkan dampak ke server.
- Jangan mengandalkan `navigator.onLine` sebagai satu-satunya penentu koneksi; gunakan hasil request server dan retry dengan backoff.

## Urutan migrasi aman

1. Bangun antrean transaksi lokal dan tampilan status tanpa mengubah aturan yang sedang dipakai.
2. Bangun endpoint backend untuk validasi dan pemrosesan penjualan secara atomik serta idempoten.
3. Alihkan transaksi online ke backend; uji kasir dan owner.
4. Alihkan transaksi offline untuk dikirim ulang ke endpoint yang sama saat online.
5. Tambahkan backend untuk void, retur, pembayaran piutang, dan mutasi saldo/stok lainnya.
6. Perketat `firestore.rules` untuk menolak penulisan langsung klien ke stok, saldo, void, dan ledger final.
7. Jalankan pengujian Emulator Rules dan skenario dua perangkat sebelum deploy rules ke proyek Firebase.

## Syarat lulus pengujian

- Satu transaksi yang dikirim ulang beberapa kali hanya tercatat sekali.
- Dua perangkat yang menjual stok terakhir tidak dapat membuat stok server menjadi negatif.
- Penjualan offline tetap tersimpan lokal dan statusnya terlihat.
- Transaksi yang gagal validasi tidak mengubah stok, saldo, piutang, atau ledger server.
- Void/retur menghasilkan pembalikan yang lengkap dan dapat diaudit.
- Kasir tidak dapat mengubah stok, saldo, harga, atau riwayat secara langsung melalui Firestore.
- Owner dapat melihat status sinkronisasi dari perangkat kedua.

## Catatan rilis

Jangan deploy aturan Firestore yang menolak penulisan stok/saldo klien sebelum seluruh modul terkait dialihkan ke backend. Aturan yang terlalu cepat diperketat akan membuat transaksi kasir saat ini gagal, termasuk antrean offline yang baru disinkronkan.
