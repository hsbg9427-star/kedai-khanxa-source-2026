import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase/firestore';
import type {
  Account,
  MiniAtmTransaction,
  PpobTransaction,
  Receivable,
  Sale,
} from '../src/types/database';
import {
  ADMIN_ONLY_TABS,
  KASIR_ALLOWED_TABS,
  canAccessNavTab,
  parseNavTab,
  resolveSafeNavTab,
} from '../src/utils/rbac';
import {
  computeCashierClosingBreakdown,
  evaluateClosingVariance,
  getClosingStatusLabel,
} from '../src/utils/cashierClosing';

const CASH_ACC: Account = {
  id: 'acc_cash',
  name: 'Laci Kas Utama',
  type: 'cash',
  balance: 1000000,
  isActive: true,
  updatedByUid: 'admin_1',
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};

const BANK_ACC: Account = {
  id: 'acc_bri',
  name: 'BRI Toko',
  type: 'bank',
  balance: 5000000,
  isActive: true,
  updatedByUid: 'admin_1',
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};

const DANA_ACC: Account = {
  id: 'acc_dana',
  name: 'DANA QRIS Warung',
  type: 'ewallet',
  balance: 2000000,
  isActive: true,
  updatedByUid: 'admin_1',
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};

const PPOB_DEP: Account = {
  id: 'acc_ppob',
  name: 'Deposit PPOB',
  type: 'ppob_deposit',
  balance: 1500000,
  isActive: true,
  updatedByUid: 'admin_1',
  createdAt: Timestamp.now(),
  updatedAt: Timestamp.now(),
};

const ACCOUNTS = [CASH_ACC, BANK_ACC, DANA_ACC, PPOB_DEP];

test('RBAC: Admin dapat mengakses seluruh modul sedangkan Kasir hanya modul operasional + closing', () => {
  for (const tab of ADMIN_ONLY_TABS) {
    assert.equal(canAccessNavTab(tab, true), true, `Admin harus dapat mengakses ${tab}`);
    assert.equal(canAccessNavTab(tab, false), false, `Kasir dilarang mengakses ${tab}`);
    assert.equal(resolveSafeNavTab(tab, false), 'dashboard');
  }

  for (const tab of KASIR_ALLOWED_TABS) {
    assert.equal(canAccessNavTab(tab, true), true);
    assert.equal(canAccessNavTab(tab, false), true, `Kasir harus dapat mengakses ${tab}`);
    assert.equal(resolveSafeNavTab(tab, false), tab);
  }

  assert.equal(parseNavTab('#mini_atm', false), 'mini_atm');
  assert.equal(parseNavTab('ppob', true), 'ppob');
  assert.equal(parseNavTab('#settings', false), 'dashboard');
  assert.equal(parseNavTab('#settings', true), 'settings');
  assert.equal(parseNavTab('#unknown_tab', true), 'dashboard');
  assert.equal(parseNavTab(undefined, true), 'dashboard');
});

test('Closing Kasir memisahkan Tunai vs Non-Tunai (QRIS, Transfer, DANA, Mini ATM, PPOB, Piutang) dengan akurat', () => {
  const kasirUid = 'kasir_1';
  const otherUid = 'kasir_2';

  const sales: Sale[] = [
    // 1. Penjualan tunai murni Rp100.000
    {
      id: 'sale_1',
      transactionNumber: 'POS-001',
      transactionDate: '2026-11-18',
      transactionTime: '09:00:00',
      totalItems: 2,
      subtotal: 100000,
      discount: 0,
      totalAmount: 100000,
      paidAmount: 100000,
      changeAmount: 0,
      debtAmount: 0,
      paymentMethod: 'cash',
      accountId: CASH_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    // 2. Penjualan QRIS Rp75.000 -> NON-TUNAI (tidak menambah expectedCash!)
    {
      id: 'sale_2',
      transactionNumber: 'POS-002',
      transactionDate: '2026-11-18',
      transactionTime: '09:30:00',
      totalItems: 1,
      subtotal: 75000,
      discount: 0,
      totalAmount: 75000,
      paidAmount: 75000,
      changeAmount: 0,
      debtAmount: 0,
      paymentMethod: 'qris',
      qrisAccountId: DANA_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    // 3. Penjualan Campuran (Mixed) Total Rp120.000: Tunai Rp40.000 + QRIS Rp80.000
    {
      id: 'sale_3',
      transactionNumber: 'POS-003',
      transactionDate: '2026-11-18',
      transactionTime: '10:00:00',
      totalItems: 3,
      subtotal: 120000,
      discount: 0,
      totalAmount: 120000,
      paidAmount: 120000,
      changeAmount: 0,
      debtAmount: 0,
      paymentMethod: 'mixed',
      cashPaidPart: 40000,
      qrisAmount: 80000,
      accountId: CASH_ACC.id,
      qrisAccountId: DANA_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    // 4. Penjualan Transfer Bank Rp50.000 -> NON-TUNAI
    {
      id: 'sale_4',
      transactionNumber: 'POS-004',
      transactionDate: '2026-11-18',
      transactionTime: '10:15:00',
      totalItems: 1,
      subtotal: 50000,
      discount: 0,
      totalAmount: 50000,
      paidAmount: 50000,
      changeAmount: 0,
      debtAmount: 0,
      paymentMethod: 'transfer',
      accountId: BANK_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    // 5. Penjualan Kasbon Total Rp90.000 dengan DP Tunai Rp20.000 & Hutang Rp70.000
    {
      id: 'sale_5',
      transactionNumber: 'POS-005',
      transactionDate: '2026-11-18',
      transactionTime: '10:45:00',
      totalItems: 2,
      subtotal: 90000,
      discount: 0,
      totalAmount: 90000,
      paidAmount: 20000,
      changeAmount: 0,
      debtAmount: 70000,
      paymentMethod: 'debt',
      accountId: CASH_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    // 6. Penjualan VOID atau Kasir Lain atau Tanggal Lain -> HARUS DIABAIKAN
    {
      id: 'sale_void',
      transactionNumber: 'POS-006',
      transactionDate: '2026-11-18',
      transactionTime: '11:00:00',
      totalItems: 1,
      subtotal: 200000,
      discount: 0,
      totalAmount: 200000,
      paidAmount: 200000,
      changeAmount: 0,
      debtAmount: 0,
      paymentMethod: 'cash',
      accountId: CASH_ACC.id,
      status: 'void',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    {
      id: 'sale_other',
      transactionNumber: 'POS-007',
      transactionDate: '2026-11-18',
      transactionTime: '11:05:00',
      totalItems: 1,
      subtotal: 300000,
      discount: 0,
      totalAmount: 300000,
      paidAmount: 300000,
      changeAmount: 0,
      debtAmount: 0,
      paymentMethod: 'cash',
      accountId: CASH_ACC.id,
      status: 'completed',
      recordedByUid: otherUid,
      recordedByName: 'Kasir B',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
  ];

  const miniAtmTransactions: MiniAtmTransaction[] = [
    // Tarik Tunai Rp200.000 + Jasa Rp5.000 -> Laci keluar Rp195.000
    {
      id: 'atm_1',
      transactionNumber: 'ATM-001',
      transactionDate: '2026-11-18',
      transactionTime: '11:30:00',
      serviceType: 'tarik_tunai',
      paymentChannel: 'qris',
      bankName: 'QRIS',
      principalAmount: 200000,
      adminFee: 5000,
      bankFee: 0,
      internalExtraFee: 0,
      netProfit: 5000,
      cashAccountId: CASH_ACC.id,
      bankAccountId: DANA_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    // Transfer Bank Rp300.000 + Jasa Rp7.000 + Bank Fee Rp2.500 -> Laci masuk Rp307.000
    {
      id: 'atm_2',
      transactionNumber: 'ATM-002',
      transactionDate: '2026-11-18',
      transactionTime: '12:00:00',
      serviceType: 'transfer',
      paymentChannel: 'bank_transfer',
      bankName: 'BCA',
      principalAmount: 300000,
      adminFee: 7000,
      bankFee: 2500,
      netProfit: 4500,
      cashAccountId: CASH_ACC.id,
      bankAccountId: BANK_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
  ];

  const ppobTransactions: PpobTransaction[] = [
    // PPOB Tunai ke Laci Kas Rp52.000 (jual 50rb + admin 2rb)
    {
      id: 'ppob_1',
      transactionNumber: 'PPB-001',
      transactionDate: '2026-11-18',
      transactionTime: '13:00:00',
      category: 'pulsa',
      providerName: 'Telkomsel',
      targetNumber: '081234567890',
      capitalPrice: 49000,
      sellPrice: 50000,
      adminFee: 2000,
      netProfit: 3000,
      accountId: PPOB_DEP.id,
      cashAccountId: CASH_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    // PPOB Non-Tunai (transfer ke DANA) Rp22.000 -> NON-TUNAI
    {
      id: 'ppob_2',
      transactionNumber: 'PPB-002',
      transactionDate: '2026-11-18',
      transactionTime: '13:15:00',
      category: 'pln',
      providerName: 'PLN Token',
      targetNumber: '14123456789',
      capitalPrice: 20500,
      sellPrice: 21000,
      adminFee: 1000,
      netProfit: 1500,
      accountId: PPOB_DEP.id,
      cashAccountId: DANA_ACC.id,
      status: 'completed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
    // PPOB Gagal -> diabaikan
    {
      id: 'ppob_fail',
      transactionNumber: 'PPB-003',
      transactionDate: '2026-11-18',
      transactionTime: '13:20:00',
      category: 'pulsa',
      providerName: 'XL',
      targetNumber: '087812345678',
      capitalPrice: 10000,
      sellPrice: 12000,
      adminFee: 0,
      netProfit: 2000,
      accountId: PPOB_DEP.id,
      cashAccountId: CASH_ACC.id,
      status: 'failed',
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    },
  ];

  const receivables: Receivable[] = [
    // Pelunasan utang tunai Rp50.000
    {
      id: 'rec_1',
      transactionNumber: 'KBN-001',
      transactionDate: '2026-11-18',
      transactionTime: '14:00:00',
      customerId: 'cst_1',
      customerName: 'Bu Siti',
      type: 'payment',
      amount: 50000,
      balanceAfter: 0,
      accountId: CASH_ACC.id,
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
    },
    // Pelunasan utang transfer bank Rp35.000 -> NON-TUNAI
    {
      id: 'rec_2',
      transactionNumber: 'KBN-002',
      transactionDate: '2026-11-18',
      transactionTime: '14:30:00',
      customerId: 'cst_2',
      customerName: 'Pak Budi',
      type: 'payment',
      amount: 35000,
      balanceAfter: 0,
      accountId: BANK_ACC.id,
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
    },
    // Catatan kasbon baru (bukan payment) -> tidak masuk arus kas masuk
    {
      id: 'rec_3',
      transactionNumber: 'KBN-003',
      transactionDate: '2026-11-18',
      transactionTime: '14:40:00',
      customerId: 'cst_3',
      customerName: 'Pak Ahmad',
      type: 'debt',
      amount: 70000,
      balanceAfter: 70000,
      recordedByUid: kasirUid,
      recordedByName: 'Kasir A',
      createdAt: Timestamp.now(),
    },
  ];

  const breakdown = computeCashierClosingBreakdown({
    sales,
    miniAtmTransactions,
    ppobTransactions,
    receivables,
    accounts: ACCOUNTS,
    targetCashierUid: kasirUid,
    periodStartDate: '2026-11-18',
    periodEndDate: '2026-11-18',
    openingCash: 100000,
  });

  // Total penjualan = 100k + 75k + 120k + 50k + 90k = 435.000
  assert.equal(breakdown.retailTxCount, 5);
  assert.equal(breakdown.totalSalesAmount, 435000);

  // Tunai penjualan = 100k (cash) + 40k (mixed cash) + 20k (DP debt) = 160.000
  assert.equal(breakdown.retailCashIn, 160000);
  // QRIS = 75k + 80k = 155.000
  assert.equal(breakdown.retailQrisTotal, 155000);
  // Transfer = 50.000
  assert.equal(breakdown.retailTransferTotal, 50000);
  // Piutang baru = 70.000
  assert.equal(breakdown.retailDebtCreatedTotal, 70000);

  // Mini ATM
  assert.equal(breakdown.miniAtmTxCount, 2);
  assert.equal(breakdown.miniAtmCashIn, 307000);
  assert.equal(breakdown.miniAtmCashOut, 195000);
  assert.equal(breakdown.miniAtmNonCashTotal, 502500); // 200k QRIS in + 302.5k bank out

  // PPOB
  assert.equal(breakdown.ppobTxCount, 2);
  assert.equal(breakdown.ppobCashIn, 52000);
  assert.equal(breakdown.ppobCashOut, 0);
  assert.equal(breakdown.ppobNonCashTotal, 22000);

  // Pelunasan Piutang
  assert.equal(breakdown.receivablePaymentCount, 2);
  assert.equal(breakdown.receivableCashIn, 50000);
  assert.equal(breakdown.receivableNonCashIn, 35000);

  // Total Kas Masuk = 160.000 + 307.000 + 52.000 + 50.000 = 569.000
  assert.equal(breakdown.totalCashIn, 569000);
  // Total Kas Keluar = 195.000
  assert.equal(breakdown.totalCashOut, 195000);
  // Uang Fisik yang Diharapkan = Modal Awal 100.000 + 569.000 - 195.000 = 474.000
  assert.equal(breakdown.expectedCash, 474000);
  // Non-cash total = 155.000 + 50.000 + 22.000 + 35.000 = 262.000
  assert.equal(breakdown.totalNonCashAmount, 262000);
});

test('evaluateClosingVariance mengembalikan status Sesuai/Balance, Kurang/Short, dan Lebih/Over dengan tepat', () => {
  const bal = evaluateClosingVariance(474000, 474000);
  assert.equal(bal.status, 'balance');
  assert.equal(bal.varianceAmount, 0);
  assert.equal(bal.statusLabel, getClosingStatusLabel('balance'));

  const short = evaluateClosingVariance(474000, 470000);
  assert.equal(short.status, 'short');
  assert.equal(short.varianceAmount, -4000);
  assert.equal(short.statusLabel, 'Kurang / Short');

  const over = evaluateClosingVariance(474000, 480000);
  assert.equal(over.status, 'over');
  assert.equal(over.varianceAmount, 6000);
  assert.equal(over.statusLabel, 'Lebih / Over');
});
