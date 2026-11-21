import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase/firestore';
import type { Product, StockBatch } from '../src/types/database';
import {
  checkDuplicateProduct,
  computeBarcodeLockKey,
  computeProductIdentityKey,
  DUPLICATE_PRODUCT_WARNING,
} from '../src/utils/productIdentity';
import {
  addCalendarMonths,
  calculateDaysRemaining,
  collectExpiryAlerts,
  computeEstimatedExpiryDate,
  evaluateBatchExpiry,
  getEffectiveExpiryDate,
  getExpiryStatus,
  planFefoBatchDeduction,
  resolveDefaultProductExpiryInput,
  resolveProductExpiryDates,
  summarizeProductBatches,
} from '../src/utils/expiryUtils';

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: overrides.id ?? 'prd_1',
    sku: overrides.sku ?? 'SKU-001',
    name: overrides.name ?? 'Indomie Goreng',
    brand: overrides.brand,
    variant: overrides.variant,
    barcode: overrides.barcode,
    categoryId: 'cat_1',
    categoryName: 'Mie Instan',
    unit: 'PCS',
    costPrice: 2500,
    sellPrice: 3500,
    stock: overrides.stock ?? 10,
    minStock: 2,
    isActive: true,
    createdByUid: 'admin_1',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

function makeBatch(overrides: Partial<StockBatch> = {}): StockBatch {
  const startDate = overrides.startDate ?? '2026-01-01';
  const estimatedExpiryDate =
    overrides.estimatedExpiryDate ?? computeEstimatedExpiryDate(startDate);
  const actualExpiryDate = overrides.actualExpiryDate;
  const effectiveExpiryDate =
    overrides.effectiveExpiryDate ??
    getEffectiveExpiryDate(estimatedExpiryDate, actualExpiryDate);

  return {
    id: overrides.id ?? 'bat_1',
    batchNumber: overrides.batchNumber ?? 'BAT-20260101-A1B2',
    productId: overrides.productId ?? 'prd_1',
    productName: overrides.productName ?? 'Indomie Goreng',
    baseUnit: overrides.baseUnit ?? 'PCS',
    sourceType: overrides.sourceType ?? 'purchase',
    startDate,
    estimatedExpiryDate,
    actualExpiryDate,
    effectiveExpiryDate,
    initialBaseQty: overrides.initialBaseQty ?? 10,
    remainingBaseQty: overrides.remainingBaseQty ?? 10,
    status: overrides.status ?? 'active',
    recordedByUid: 'admin_1',
    recordedByName: 'Admin',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

test('Skenario 1: Menambahkan produk yang sudah terdaftar harus ditolak (abaikan huruf besar/kecil & spasi berlebih)', () => {
  const existing: Product[] = [
    makeProduct({
      id: 'prd_indomie',
      name: 'Indomie Goreng',
      brand: 'Indofood',
      variant: '85 gr',
      barcode: '8998866200011',
    }),
  ];

  // Duplikat berdasarkan identitas (huruf kapital & spasi berlebih berbeda)
  const dupIdentity = checkDuplicateProduct(
    {
      name: '  indomie   GORENG ',
      brand: 'INDOFOOD',
      variant: ' 85   GR ',
    },
    existing
  );
  assert.equal(dupIdentity.isDuplicate, true);
  assert.equal(dupIdentity.matchType, 'identity');
  assert.equal(dupIdentity.existingProduct?.id, 'prd_indomie');
  assert.equal(dupIdentity.message, DUPLICATE_PRODUCT_WARNING);

  // Duplikat berdasarkan barcode (termasuk spasi di sekitar barcode)
  const dupBarcode = checkDuplicateProduct(
    {
      name: 'Mie Goreng Spesial Nama Lain',
      brand: 'Merek Lain',
      variant: '90 gr',
      barcode: ' 8998866200011 ',
    },
    existing
  );
  assert.equal(dupBarcode.isDuplicate, true);
  assert.equal(dupBarcode.matchType, 'barcode');
  assert.equal(dupBarcode.existingProduct?.id, 'prd_indomie');
  assert.equal(dupBarcode.message, DUPLICATE_PRODUCT_WARNING);
});

test('Skenario 2: Menambahkan produk dengan merek sama tetapi ukuran atau varian berbeda tetap diperbolehkan', () => {
  const existing: Product[] = [
    makeProduct({
      id: 'prd_teh_250',
      name: 'Teh Botol',
      brand: 'Sosro',
      variant: '250 ml',
      barcode: '89910001',
    }),
  ];

  const diffVariant = checkDuplicateProduct(
    {
      name: 'Teh Botol',
      brand: 'Sosro',
      variant: '450 ml',
      barcode: '89910002',
    },
    existing
  );

  assert.equal(diffVariant.isDuplicate, false);
  assert.equal(diffVariant.existingProduct, undefined);
});

test('Skenario 3: Pembelian pada tanggal tertentu otomatis menghitung perkiraan kedaluwarsa +6 bulan kalender (termasuk akhir bulan & tahun kabisat)', () => {
  // Pergantian tahun normal
  assert.equal(computeEstimatedExpiryDate('2026-10-15'), '2027-04-15');
  // Akhir bulan 31 Agustus -> Februari tahun bukan kabisat (28)
  assert.equal(computeEstimatedExpiryDate('2026-08-31'), '2027-02-28');
  // Akhir bulan 31 Agustus -> Februari tahun kabisat 2024 (29)
  assert.equal(computeEstimatedExpiryDate('2023-08-31'), '2024-02-29');
  // Penyesuaian tanggal 31 Maret + 6 bulan -> 30 September (30 hari)
  assert.equal(addCalendarMonths('2026-03-31', 6), '2026-09-30');
});

test('Skenario 4: Memasukkan stok tanpa pembelian menggunakan tanggal input sebagai tanggal awal perhitungan', () => {
  const inputDate = '2026-05-20';
  const batch = makeBatch({
    sourceType: 'manual_stock',
    startDate: inputDate,
  });

  assert.equal(batch.startDate, '2026-05-20');
  assert.equal(batch.estimatedExpiryDate, '2026-11-20');
  assert.equal(batch.effectiveExpiryDate, '2026-11-20');
});

test('Skenario 5: Mengubah tanggal kedaluwarsa aktual kemasan menggantikan perkiraan dan diprioritaskan', () => {
  const estimated = computeEstimatedExpiryDate('2026-01-10'); // 2026-07-10
  const actualPackaging = '2026-09-05';
  const batch = makeBatch({
    startDate: '2026-01-10',
    estimatedExpiryDate: estimated,
    actualExpiryDate: actualPackaging,
    effectiveExpiryDate: getEffectiveExpiryDate(estimated, actualPackaging),
  });

  const evalResult = evaluateBatchExpiry(batch, '2026-07-01');
  assert.equal(evalResult.isActualPackagingDate, true);
  assert.equal(evalResult.effectiveExpiryDate, '2026-09-05');
  assert.equal(evalResult.expiryStatus, 'AMAN'); // > 30 hari dari 2026-07-01 (66 hari)

  // Jika actualExpiryDate dihapus/kosong, kembali memakai tanggal perkiraan +6 bulan
  assert.equal(getEffectiveExpiryDate(estimated, undefined), '2026-07-10');
});

test('Skenario 6: Satu produk dengan dua batch pembelian tanggal berbeda tercatat terpisah dan tidak digabung', () => {
  const product = makeProduct({ id: 'prd_susu', name: 'Susu UHT', stock: 30 });
  const batch1 = makeBatch({
    id: 'bat_a',
    batchNumber: 'BAT-20260101-0001',
    productId: 'prd_susu',
    startDate: '2026-01-01', // Est 2026-07-01
    initialBaseQty: 12,
    remainingBaseQty: 12,
  });
  const batch2 = makeBatch({
    id: 'bat_b',
    batchNumber: 'BAT-20260301-0002',
    productId: 'prd_susu',
    startDate: '2026-03-01', // Est 2026-09-01
    actualExpiryDate: '2026-08-15',
    effectiveExpiryDate: '2026-08-15',
    initialBaseQty: 18,
    remainingBaseQty: 18,
  });

  const summary = summarizeProductBatches(product, [batch2, batch1], '2026-05-01');
  assert.equal(summary.allBatchesEvaluated.length, 2);
  // Diurutkan berdasarkan tanggal kedaluwarsa terdekat tanpa digabung
  assert.equal(summary.allBatchesEvaluated[0].id, 'bat_a');
  assert.equal(summary.allBatchesEvaluated[0].effectiveExpiryDate, '2026-07-01');
  assert.equal(summary.allBatchesEvaluated[1].id, 'bat_b');
  assert.equal(summary.allBatchesEvaluated[1].effectiveExpiryDate, '2026-08-15');
  assert.equal(summary.trackedBatchStock, 30);

  // Penjualan FEFO 15 pcs memotong 12 dari batch1 (habis) + 3 dari batch2 (sisa 15)
  const fefo = planFefoBatchDeduction(product, [batch1, batch2], 15, false, '2026-05-01');
  assert.equal(fefo.ok, true);
  assert.equal(fefo.allocations.length, 2);
  assert.deepEqual(fefo.allocations[0], {
    batchId: 'bat_a',
    batchNumber: 'BAT-20260101-0001',
    deductQty: 12,
    remainingAfter: 0,
    nextStatus: 'depleted',
    isExpiredBatch: false,
    effectiveExpiryDate: '2026-07-01',
  });
  assert.deepEqual(fefo.allocations[1], {
    batchId: 'bat_b',
    batchNumber: 'BAT-20260301-0002',
    deductQty: 3,
    remainingAfter: 15,
    nextStatus: 'active',
    isExpiredBatch: false,
    effectiveExpiryDate: '2026-08-15',
  });
});

test('Skenario 7 & 8: Sisa 30 hari dan sisa 29 hari memunculkan peringatan MENDEKATI EXPIRED (sedangkan 31 hari AMAN)', () => {
  const batch = makeBatch({
    startDate: '2026-01-01',
    estimatedExpiryDate: '2026-07-01',
    effectiveExpiryDate: '2026-07-01',
    remainingBaseQty: 5,
    status: 'active',
  });

  // 31 hari sebelum 2026-07-01 -> 2026-05-31 (AMAN)
  assert.equal(calculateDaysRemaining('2026-07-01', '2026-05-31'), 31);
  assert.equal(getExpiryStatus('2026-07-01', '2026-05-31'), 'AMAN');
  assert.equal(evaluateBatchExpiry(batch, '2026-05-31').needsDashboardAlert, false);

  // 30 hari sebelum 2026-07-01 -> 2026-06-01 (peringatan mulai muncul)
  assert.equal(calculateDaysRemaining('2026-07-01', '2026-06-01'), 30);
  const eval30 = evaluateBatchExpiry(batch, '2026-06-01');
  assert.equal(eval30.expiryStatus, 'MENDEKATI EXPIRED');
  assert.equal(eval30.needsDashboardAlert, true);

  // 29 hari sebelum 2026-07-01 -> 2026-06-02 (peringatan tetap muncul)
  assert.equal(calculateDaysRemaining('2026-07-01', '2026-06-02'), 29);
  const eval29 = evaluateBatchExpiry(batch, '2026-06-02');
  assert.equal(eval29.expiryStatus, 'MENDEKATI EXPIRED');
  assert.equal(eval29.needsDashboardAlert, true);
});

test('Skenario 9: Barang sudah kedaluwarsa berstatus EXPIRED dan riwayat tidak dihapus otomatis', () => {
  const expiredBatch = makeBatch({
    id: 'bat_exp',
    startDate: '2026-01-01',
    estimatedExpiryDate: '2026-07-01',
    effectiveExpiryDate: '2026-07-01',
    remainingBaseQty: 8,
    status: 'active',
  });

  const evalOnDay = evaluateBatchExpiry(expiredBatch, '2026-07-01');
  assert.equal(evalOnDay.daysRemaining, 0);
  assert.equal(evalOnDay.expiryStatus, 'EXPIRED');
  assert.equal(evalOnDay.needsDashboardAlert, true);

  const evalPast = evaluateBatchExpiry(expiredBatch, '2026-07-10');
  assert.equal(evalPast.daysRemaining, -9);
  assert.equal(evalPast.expiryStatus, 'EXPIRED');
  assert.equal(evalPast.needsDashboardAlert, true);

  // Setelah ditangani / ditarik Admin, notifikasi aktif berhenti tetapi data riwayat tetap dipertahankan
  const pulledBatch = { ...expiredBatch, status: 'pulled' as const, remainingBaseQty: 0 };
  const summaryAfterPull = summarizeProductBatches(
    makeProduct({ id: 'prd_1', stock: 0 }),
    [pulledBatch],
    '2026-07-10'
  );
  assert.equal(summaryAfterPull.allBatchesEvaluated.length, 1);
  assert.equal(summaryAfterPull.allBatchesEvaluated[0].needsDashboardAlert, false);
});

test('Skenario 10: Barang kedaluwarsa tidak boleh dijual tanpa persetujuan Admin', () => {
  const product = makeProduct({ id: 'prd_roti', name: 'Roti Tawar', stock: 10 });
  const expiredBatch = makeBatch({
    id: 'bat_exp_roti',
    batchNumber: 'BAT-EXP-1',
    productId: 'prd_roti',
    startDate: '2025-10-01',
    estimatedExpiryDate: '2026-04-01',
    effectiveExpiryDate: '2026-04-01',
    remainingBaseQty: 4,
    status: 'active',
  });
  const freshBatch = makeBatch({
    id: 'bat_fresh_roti',
    batchNumber: 'BAT-FRESH-2',
    productId: 'prd_roti',
    startDate: '2026-03-01',
    estimatedExpiryDate: '2026-09-01',
    effectiveExpiryDate: '2026-09-01',
    remainingBaseQty: 6,
    status: 'active',
  });

  // Membeli 6 pcs (hanya memakai stok aman freshBatch) diizinkan
  const safeSale = planFefoBatchDeduction(
    product,
    [expiredBatch, freshBatch],
    6,
    false,
    '2026-06-01'
  );
  assert.equal(safeSale.ok, true);
  assert.equal(safeSale.usedExpiredBatches, false);
  assert.equal(safeSale.allocations[0].batchId, 'bat_fresh_roti');

  // Membeli 8 pcs menyentuh expiredBatch (2 pcs) -> DITOLAK tanpa persetujuan Admin
  const blockedSale = planFefoBatchDeduction(
    product,
    [expiredBatch, freshBatch],
    8,
    false,
    '2026-06-01'
  );
  assert.equal(blockedSale.ok, false);
  assert.equal(blockedSale.blockedByExpired, true);

  // Jika Admin memberikan persetujuan eksplisit, penjualan diizinkan & batch expired tercatat
  const approvedSale = planFefoBatchDeduction(
    product,
    [expiredBatch, freshBatch],
    8,
    true,
    '2026-06-01'
  );
  assert.equal(approvedSale.ok, true);
  assert.equal(approvedSale.usedExpiredBatches, true);
  assert.equal(approvedSale.allocations.length, 2);
  assert.equal(approvedSale.allocations[0].batchId, 'bat_fresh_roti');
  assert.equal(approvedSale.allocations[1].batchId, 'bat_exp_roti');
  assert.equal(approvedSale.allocations[1].deductQty, 2);
});

test('Skenario 11: Sinkronisasi dua perangkat (offline & online) menghasilkan lock key deterministik agar tidak terjadi produk ganda', () => {
  // Perangkat A dan Perangkat B menginput produk sama secara offline dengan format ketik berbeda
  const keyDeviceA = computeProductIdentityKey('  kopi kapal api ', 'Santos Jaya', '165 gr');
  const keyDeviceB = computeProductIdentityKey('KOPI   KAPAL   API', 'santos   jaya', '165   GR');
  assert.equal(keyDeviceA, keyDeviceB);

  const bcDeviceA = computeBarcodeLockKey(' 8991002101122 ');
  const bcDeviceB = computeBarcodeLockKey('8991002101122');
  assert.ok(bcDeviceA);
  assert.equal(bcDeviceA, bcDeviceB);

  // Simulasi validasi atomik server (!exists pada koleksi product_identity_locks & barcode_locks)
  const serverIdentityLocks = new Set<string>();
  const serverBarcodeLocks = new Set<string>();

  const tryServerSyncCreate = (identityKey: string, barcodeKey?: string): boolean => {
    if (serverIdentityLocks.has(identityKey)) return false;
    if (barcodeKey && serverBarcodeLocks.has(barcodeKey)) return false;
    serverIdentityLocks.add(identityKey);
    if (barcodeKey) serverBarcodeLocks.add(barcodeKey);
    return true;
  };

  // Perangkat A lebih dulu sinkron -> berhasil
  assert.equal(tryServerSyncCreate(keyDeviceA, bcDeviceA), true);
  // Perangkat B menyusul sinkron -> ditolak oleh kunci atomik sehingga tidak menghasilkan produk ganda
  assert.equal(tryServerSyncCreate(keyDeviceB, bcDeviceB), false);
  assert.equal(serverIdentityLocks.size, 1);
  assert.equal(serverBarcodeLocks.size, 1);
});

test('Skenario 12: Input produk (termasuk stok 0) otomatis menetapkan expired +6 bulan dari tanggal input dan pemberitahuan 1 bulan sebelumnya', () => {
  // 1. Produk baru tanpa override ED aktual -> otomatis +6 bulan kalender
  const autoRes = resolveDefaultProductExpiryInput('2026-02-15');
  assert.equal(autoRes.inputDate, '2026-02-15');
  assert.equal(autoRes.estimatedExpiryDate, '2026-08-15');
  assert.equal(autoRes.actualExpiryDate, undefined);
  assert.equal(autoRes.expiryDate, '2026-08-15');

  // 2. Produk dengan ED kemasan aktual tetap memprioritaskan tanggal aktual
  const overrideRes = resolveDefaultProductExpiryInput('2026-02-15', '2026-10-01');
  assert.equal(overrideRes.expiryDate, '2026-10-01');

  // 3. Produk stok 0 dengan inputDate & expiryDate tetap memicu notifikasi 1 bulan (<= 30 hari) sebelum expired
  const zeroStockNearExpProduct = makeProduct({
    id: 'prd_zero_near',
    name: 'Saus Sambal Sachet',
    stock: 0,
    inputDate: '2026-01-15',
    expiryDate: '2026-07-15',
  });
  const resolved = resolveProductExpiryDates(zeroStockNearExpProduct);
  assert.equal(resolved.hasExplicitDates, true);
  assert.equal(resolved.effectiveExpiryDate, '2026-07-15');

  // 31 hari sebelum 2026-07-15 (2026-06-14) -> belum muncul pemberitahuan
  const alertsBeforeThreshold = collectExpiryAlerts([zeroStockNearExpProduct], [], '2026-06-14');
  assert.equal(alertsBeforeThreshold.length, 0);

  // Tepat 30 hari / ~1 bulan sebelum 2026-07-15 (2026-06-15) -> pemberitahuan muncul
  const alertsAt1Month = collectExpiryAlerts([zeroStockNearExpProduct], [], '2026-06-15');
  assert.equal(alertsAt1Month.length, 1);
  assert.equal(alertsAt1Month[0].source, 'product');
  assert.equal(alertsAt1Month[0].expiryStatus, 'MENDEKATI EXPIRED');
  assert.equal(alertsAt1Month[0].daysRemaining, 30);

  // 4. Produk yang sudah memiliki batch aktif tidak diduplikasi oleh fallback product-level, dan EXPIRED diurutkan paling atas
  const batchedProduct = makeProduct({
    id: 'prd_batched_exp',
    name: 'Roti Coklat',
    stock: 5,
    inputDate: '2025-11-01',
    expiryDate: '2026-05-01',
  });
  const expiredBatch = makeBatch({
    id: 'bat_roti_exp',
    productId: 'prd_batched_exp',
    productName: 'Roti Coklat',
    startDate: '2025-11-01',
    estimatedExpiryDate: '2026-05-01',
    effectiveExpiryDate: '2026-05-01',
    remainingBaseQty: 5,
    status: 'active',
  });

  const combinedAlerts = collectExpiryAlerts(
    [zeroStockNearExpProduct, batchedProduct],
    [expiredBatch],
    '2026-06-15'
  );
  assert.equal(combinedAlerts.length, 2);
  assert.equal(combinedAlerts[0].productId, 'prd_batched_exp');
  assert.equal(combinedAlerts[0].source, 'batch');
  assert.equal(combinedAlerts[0].expiryStatus, 'EXPIRED');
  assert.equal(combinedAlerts[1].productId, 'prd_zero_near');
  assert.equal(combinedAlerts[1].source, 'product');
  assert.equal(combinedAlerts[1].expiryStatus, 'MENDEKATI EXPIRED');
});

test('Skenario 13: Pengurangan stok sub-satuan (1 Bks = 12 BATANG) dan format pesan error Firestore terbaca bersih tanpa JSON mentah', async () => {
  const { computeBaseQuantityFromUnit, snapStockToProductPrecision } = await import(
    '../src/utils/unitConversion'
  );
  const { getReadableFirestoreError } = await import('../src/utils/firestoreError');

  const rokokProduct = makeProduct({
    id: 'prd_reffil_12',
    name: 'REFFIL 12',
    unit: 'Bks',
    stock: 4.916667, // 4 Bks 11 BATANG
    sellUnits: [
      {
        unitName: 'BATANG',
        conversion: 0.083333,
        conversionMode: 'divide',
        perBaseQty: 12,
        sellPrice: 2000,
        canBuy: false,
        canSell: true,
      },
    ],
  });

  const baseQty1Batang = computeBaseQuantityFromUnit(1, {
    conversion: 0.083333,
    conversionMode: 'divide',
    perBaseQty: 12,
  });
  assert.ok(baseQty1Batang > 0 && baseQty1Batang < 0.09);

  const rawLiveStock = Number(rokokProduct.stock);
  const liveSnapped = snapStockToProductPrecision(rawLiveStock, rokokProduct);
  const computedAfter = snapStockToProductPrecision(
    Math.max(0, liveSnapped - baseQty1Batang),
    rokokProduct
  );
  const clampedFinalStock = Math.min(rawLiveStock, Math.max(0, computedAfter));
  assert.ok(clampedFinalStock <= rawLiveStock);
  assert.equal(Math.round(clampedFinalStock * 12), 58); // 4 Bks 10 BATANG

  const rawPermJson = JSON.stringify({
    error: 'Missing or insufficient permissions.',
    operationType: 'write',
    path: 'sales/sale_123',
  });
  const readablePerm = getReadableFirestoreError(new Error(rawPermJson));
  assert.equal(readablePerm.startsWith('{'), false);
  assert.match(readablePerm, /Akses ditolak oleh aturan keamanan Firestore/);

  const domainErr = getReadableFirestoreError(
    new Error('Stok "REFFIL 12" tidak mencukupi.')
  );
  assert.equal(domainErr, 'Stok "REFFIL 12" tidak mencukupi.');
});


