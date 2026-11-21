import test from 'node:test';
import assert from 'node:assert/strict';
import type { Timestamp } from 'firebase/firestore';
import type {
  Account,
  MiniAtmTransaction,
  PpobTransaction,
  Receivable,
  Sale,
} from '../src/types/database';
import {
  calculateMiniAtmBreakdown,
  calculatePpobBreakdown,
} from '../src/utils/serviceTransactions';
import { calculateCombinedPosSettlement } from '../src/utils/qrisFee';
import { computeCashierClosingBreakdown } from '../src/utils/cashierClosing';

const fakeTs = {} as Timestamp;

test('calculateMiniAtmBreakdown handles Transfer Bank Lunas, Hutang penuh, and Hutang dengan DP', () => {
  const paidRes = calculateMiniAtmBreakdown({
    serviceType: 'transfer',
    paymentChannel: 'bank_transfer',
    paymentStatus: 'paid',
    principalAmount: 200000,
    adminFee: 5000,
    bankFee: 2500,
  });
  assert.equal(paidRes.paymentStatus, 'paid');
  assert.equal(paidRes.paidAmount, 205000);
  assert.equal(paidRes.debtAmount, 0);
  assert.equal(paidRes.cashDelta, 205000);
  assert.equal(paidRes.bankDelta, -202500);
  assert.equal(paidRes.netProfit, 2500);

  const debtFull = calculateMiniAtmBreakdown({
    serviceType: 'transfer',
    paymentChannel: 'bank_transfer',
    paymentStatus: 'debt',
    paidAmount: 0,
    principalAmount: 200000,
    adminFee: 5000,
    bankFee: 2500,
  });
  assert.equal(debtFull.paymentStatus, 'debt');
  assert.equal(debtFull.totalDue, 205000);
  assert.equal(debtFull.paidAmount, 0);
  assert.equal(debtFull.debtAmount, 205000);
  assert.equal(debtFull.cashDelta, 0);
  assert.equal(debtFull.bankDelta, -202500);
  assert.equal(debtFull.netProfit, 2500);

  const debtPartial = calculateMiniAtmBreakdown({
    serviceType: 'transfer',
    paymentChannel: 'bank_transfer',
    paymentStatus: 'debt',
    paidAmount: 55000,
    principalAmount: 200000,
    adminFee: 5000,
    bankFee: 2500,
  });
  assert.equal(debtPartial.paidAmount, 55000);
  assert.equal(debtPartial.debtAmount, 150000);
  assert.equal(debtPartial.cashDelta, 55000);
  assert.equal(debtPartial.bankDelta, -202500);
});

test('calculateMiniAtmBreakdown enforces QRIS lock on debt and computes Tarik Tunai debt without bank mutation', () => {
  assert.throws(
    () =>
      calculateMiniAtmBreakdown({
        serviceType: 'tarik_tunai',
        paymentChannel: 'qris',
        paymentStatus: 'debt',
        allowQrisTarikTunai: true,
        qrisVerified: true,
        principalAmount: 100000,
        adminFee: 5000,
        bankFee: 0,
      }),
    /QRIS hanya dapat digunakan untuk transaksi Lunas/i
  );

  assert.throws(
    () =>
      calculateMiniAtmBreakdown({
        serviceType: 'tarik_tunai',
        paymentChannel: 'bank_transfer',
        paymentStatus: 'debt',
        paidAmount: 105000,
        principalAmount: 100000,
        adminFee: 5000,
        bankFee: 0,
      }),
    /Status Lunas/i
  );

  const tarikDebt = calculateMiniAtmBreakdown({
    serviceType: 'tarik_tunai',
    paymentChannel: 'bank_transfer',
    paymentStatus: 'debt',
    paidAmount: 5000,
    principalAmount: 100000,
    adminFee: 5000,
    bankFee: 0,
  });
  assert.equal(tarikDebt.totalDue, 105000);
  assert.equal(tarikDebt.paidAmount, 5000);
  assert.equal(tarikDebt.debtAmount, 100000);
  assert.equal(tarikDebt.cashDelta, -95000);
  assert.equal(tarikDebt.bankDelta, 0);
  assert.equal(tarikDebt.netProfit, 5000);
});

test('calculatePpobBreakdown supports Lunas vs Hutang + DP and rejects full DP', () => {
  const paid = calculatePpobBreakdown({
    capitalPrice: 50500,
    sellPrice: 52000,
    adminFee: 1000,
    paymentStatus: 'paid',
  });
  assert.equal(paid.paymentStatus, 'paid');
  assert.equal(paid.customerTotal, 53000);
  assert.equal(paid.paidAmount, 53000);
  assert.equal(paid.debtAmount, 0);
  assert.equal(paid.cashReceiptDelta, 53000);
  assert.equal(paid.netProfit, 2500);

  const debt = calculatePpobBreakdown({
    capitalPrice: 50500,
    sellPrice: 52000,
    adminFee: 1000,
    paymentStatus: 'debt',
    paidAmount: 13000,
  });
  assert.equal(debt.paymentStatus, 'debt');
  assert.equal(debt.paidAmount, 13000);
  assert.equal(debt.debtAmount, 40000);
  assert.equal(debt.cashReceiptDelta, 13000);
  assert.equal(debt.depositDelta, -50500);
  assert.equal(debt.netProfit, 2500);

  assert.throws(
    () =>
      calculatePpobBreakdown({
        capitalPrice: 50500,
        sellPrice: 52000,
        adminFee: 1000,
        paymentStatus: 'debt',
        paidAmount: 53000,
      }),
    /Lunas/i
  );
});

test('Closing Kasir reconciles Mini ATM/PPOB Hutang DP, combined Retail+Bon payment, and skips void reversals without accountId', () => {
  const accounts: Account[] = [
    {
      id: 'acc_cash',
      name: 'Laci Kasir',
      type: 'cash',
      balance: 0,
      isActive: true,
      updatedByUid: 'u1',
      createdAt: fakeTs,
      updatedAt: fakeTs,
    },
    {
      id: 'acc_bank',
      name: 'Bank BCA',
      type: 'bank',
      balance: 0,
      isActive: true,
      updatedByUid: 'u1',
      createdAt: fakeTs,
      updatedAt: fakeTs,
    },
    {
      id: 'acc_ppob',
      name: 'Deposit PPOB',
      type: 'ppob_deposit',
      balance: 0,
      isActive: true,
      updatedByUid: 'u1',
      createdAt: fakeTs,
      updatedAt: fakeTs,
    },
  ];

  // Customer Ibu Siti builds combined debt:
  // 1) Mini ATM Transfer 100k + admin 5k = 105k, DP 5k -> Bon +100k, Cash +5k
  // 2) PPOB Token 52k + admin 2k = 54k, DP 4k -> Bon +50k, Cash +4k
  // Combined Bon = 150k. Later at Kasir POS, Ibu Siti buys groceries 25k and pays off all 150k bon in cash!
  const miniAtmTx: MiniAtmTransaction = {
    id: 'atm1',
    transactionNumber: 'ATM-001',
    transactionDate: '2026-11-19',
    transactionTime: '09:00:00',
    serviceType: 'transfer',
    paymentChannel: 'bank_transfer',
    paymentStatus: 'debt',
    customerId: 'c_siti',
    customerName: 'Ibu Siti',
    paidAmount: 5000,
    debtAmount: 100000,
    bankName: 'BRI',
    principalAmount: 100000,
    adminFee: 5000,
    bankFee: 0,
    netProfit: 5000,
    cashAccountId: 'acc_cash',
    bankAccountId: 'acc_bank',
    status: 'completed',
    recordedByUid: 'kasir1',
    recordedByName: 'Kasir 1',
    createdAt: fakeTs,
    updatedAt: fakeTs,
  };

  const ppobTx: PpobTransaction = {
    id: 'ppb1',
    transactionNumber: 'PPB-001',
    transactionDate: '2026-11-19',
    transactionTime: '09:15:00',
    category: 'pln',
    providerName: 'PLN Token',
    targetNumber: '14123456789',
    customerId: 'c_siti',
    customerName: 'Ibu Siti',
    paymentStatus: 'debt',
    paidAmount: 4000,
    debtAmount: 50000,
    capitalPrice: 50500,
    sellPrice: 52000,
    adminFee: 2000,
    netProfit: 3500,
    accountId: 'acc_ppob',
    cashAccountId: 'acc_cash',
    status: 'completed',
    recordedByUid: 'kasir1',
    recordedByName: 'Kasir 1',
    createdAt: fakeTs,
    updatedAt: fakeTs,
  };

  const combined = calculateCombinedPosSettlement({
    saleTotalAmount: 25000,
    paymentMethod: 'cash',
    paidAmount: 200000,
    qrisFeePercent: 0.3,
    customerPrevDebt: 150000,
    receivablePayAmount: 150000,
  });

  const sale: Sale = {
    id: 'sale1',
    transactionNumber: 'POS-100',
    transactionDate: '2026-11-19',
    transactionTime: '11:00:00',
    customerId: 'c_siti',
    customerName: 'Ibu Siti',
    totalItems: 1,
    subtotal: 25000,
    discount: 0,
    totalAmount: 25000,
    paidAmount: combined.grandPaidAmount,
    changeAmount: combined.grandChangeAmount,
    debtAmount: 0,
    receivablePaidAmount: combined.receivablePaidAmount,
    customerDebtBefore: 150000,
    customerDebtAfter: 0,
    paymentMethod: 'cash',
    cashPaidPart: 25000,
    qrisAmount: 0,
    qrisFeeRate: 0,
    qrisFeeAmount: 0,
    netReceivedAmount: 25000,
    accountId: 'acc_cash',
    status: 'completed',
    recordedByUid: 'kasir1',
    recordedByName: 'Kasir 1',
    createdAt: fakeTs,
    updatedAt: fakeTs,
  };

  const receivables: Receivable[] = [
    {
      id: 'rec_pay_combined',
      transactionNumber: 'BYP-100',
      transactionDate: '2026-11-19',
      transactionTime: '11:00:00',
      customerId: 'c_siti',
      customerName: 'Ibu Siti',
      type: 'payment',
      amount: 150000,
      balanceAfter: 0,
      saleId: 'sale1',
      sourceType: 'sale',
      accountId: 'acc_cash',
      recordedByUid: 'kasir1',
      recordedByName: 'Kasir 1',
      createdAt: fakeTs,
    },
    // Synthetic reversal from void/refund WITHOUT accountId — must NOT inflate cash
    {
      id: 'rec_void_reversal',
      transactionNumber: 'BTL-001',
      transactionDate: '2026-11-19',
      transactionTime: '12:00:00',
      customerId: 'c_siti',
      customerName: 'Ibu Siti',
      type: 'payment',
      amount: 50000,
      balanceAfter: 0,
      sourceType: 'ppob',
      referenceId: 'ppb_failed',
      recordedByUid: 'kasir1',
      recordedByName: 'Kasir 1',
      createdAt: fakeTs,
    },
  ];

  const closing = computeCashierClosingBreakdown({
    sales: [sale],
    miniAtmTransactions: [miniAtmTx],
    ppobTransactions: [ppobTx],
    receivables,
    accounts,
    targetCashierUid: 'kasir1',
    periodStartDate: '2026-11-19',
    periodEndDate: '2026-11-19',
    openingCash: 100000,
  });

  // Expected cash = Opening 100k + Retail 25k + MiniATM DP 5k + PPOB DP 4k + Combined Bon Payment 150k = 284k
  assert.equal(closing.retailCashIn, 25000);
  assert.equal(closing.miniAtmCashIn, 5000);
  assert.equal(closing.ppobCashIn, 4000);
  assert.equal(closing.receivableCashIn, 150000);
  assert.equal(closing.receivablePaymentCount, 1);
  assert.equal(closing.expectedCash, 284000);
});
