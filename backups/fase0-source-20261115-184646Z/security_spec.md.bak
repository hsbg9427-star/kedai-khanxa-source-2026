# Spesifikasi Keamanan Firestore — KEDAI KHANXA

## 1. Invarian Data (Data Invariants)
1. **Identitas, Bootstrap Admin Utama & Hak Akses (`system_config/bootstrap`, `users`, `staff_invites`)**:
   - Dokumen tunggal `system_config/bootstrap` hanya dapat dibuat satu kali (`!exists(...)`) secara atomik bersama aktivasi `users/{uid}` dengan `role: 'admin'`, `status: 'active'`, dan bersifat kekal (tidak dapat diubah atau dihapus).
   - Setelah `system_config/bootstrap` terbentuk, tidak ada pengguna baru yang bisa mengangkat dirinya sendiri menjadi `admin` atau `kasir`; pengguna baru otomatis berstatus `pending` kecuali memiliki undangan valid di `staff_invites`.
   - Admin Utama pada `system_config/bootstrap` tidak dapat diturunkan perannya, dinonaktifkan, atau dihapus oleh siapa pun, dan email pengguna terdaftar bersifat kekal (`incoming().email == existing().email`).
   - Dokumen `users/{userId}` berisi PII (`email`, `phone`) sehingga hanya boleh dibaca oleh pemilik akun (`userId == request.auth.uid`) atau `isAdmin()`.
2. **Integritas Transaksi (`sales`, `purchases`, `mini_atm_transactions`, `ppob_transactions`, `expenses`, `cash_ledger`, `stock_movements`, `receivables`)**:
   - Setiap transaksi wajib memiliki `transactionNumber`, `transactionDate`, `transactionTime`, `recordedByUid == request.auth.uid`, `recordedByName`, dan `createdAt == request.time`.
   - Nilai `recordedByUid` dan `createdAt` bersifat kekal (immutable) setelah pembuatan.
   - Transaksi berstatus terminal (`void` atau `failed`) tidak dapat diubah lagi oleh Kasir (hanya `isAdmin()` yang dapat melakukan koreksi).
3. **Referensi Relasional**:
   - `products.categoryId` harus merujuk kategori yang benar-benar ada di `/categories/{categoryId}`.
   - `sales/{saleId}/items/{itemId}` dan `purchases/{purchaseId}/items/{itemId}` harus memvalidasi induknya via `get()` dan mencocokkan `saleId`/`purchaseId`.
   - `cash_ledger.accountId`, `expenses.accountId`, `ppob_transactions.accountId`, `mini_atm_transactions.cashAccountId`, dan `mini_atm_transactions.bankAccountId` wajib merujuk dokumen di `/accounts/{accountId}` yang eksis.
4. **Batas Ukuran & Anti-Shadow Field**:
   - Semua field string memiliki batas panjang (`size()`), ID dokumen divalidasi `^[a-zA-Z0-9_\-]+$` (maks 128 karakter), dan semua koleksi wajib memvalidasi `keys().hasAll(...)` dan `keys().hasOnly(...)`.

## 2. "Dirty Dozen" Payloads (Uji Penetrasi Keamanan)
1. **Self-Privilege Escalation**: Pengguna baru mencoba `create` di `/users/{uid}` dengan `role: 'admin'` tanpa email bootstrap atau invite valid -> **PERMISSION_DENIED**.
2. **Role Self-Update**: Kasir mencoba `update` dokumen `/users/{uid}` miliknya untuk mengubah `role` menjadi `'admin'` atau `status` menjadi `'active'` -> **PERMISSION_DENIED**.
3. **Unverified Email Spoof**: Token dengan `email: 'hsbg9427@gmail.com'` tetapi `email_verified: false` mencoba akses admin -> **PERMISSION_DENIED**.
4. **Shadow Ghost Field**: Payload `create` ke `/accounts/{id}` menyertakan field liar `isVerified: true` -> **PERMISSION_DENIED**.
5. **Identity Spoofing pada Transaksi**: Kasir A mencoba mencatat `/sales/{id}` dengan `recordedByUid: 'kasir_B_uid'` -> **PERMISSION_DENIED**.
6. **Timestamp Forgery**: Klien mengirim `createdAt` palsu (bukan `request.time`) pada `/expenses/{id}` -> **PERMISSION_DENIED**.
7. **ID Poisoning**: Klien mengirim document ID berisi karakter ilegal `../../etc` atau string > 128 karakter -> **PERMISSION_DENIED**.
8. **Orphaned Transaction**: Klien membuat `/expenses/{id}` dengan `accountId` yang tidak ada di `/accounts` -> **PERMISSION_DENIED**.
9. **PII Cross-Read**: Kasir mencoba `get` dokumen `/users/{otherUid}` milik staf lain -> **PERMISSION_DENIED**.
10. **Terminal State Bypass**: Kasir mencoba mengubah status transaksi `/sales/{id}` yang sudah `'void'` kembali menjadi `'completed'` -> **PERMISSION_DENIED**.
11. **Value Poisoning**: Klien mengupdate `balance` di `/accounts/{id}` dengan tipe string `"999999"` alih-alih number -> **PERMISSION_DENIED**.
12. **Unauthenticated List Scraping**: Klien tanpa autentikasi mencoba `list` koleksi `/products` atau `/accounts` -> **PERMISSION_DENIED**.
