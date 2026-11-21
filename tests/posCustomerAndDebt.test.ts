import test from 'node:test';
import assert from 'node:assert/strict';
import type { Timestamp } from 'firebase/firestore';
import type { Account, Customer, Receivable, Sale } from '../src/types/database';
import {
  calculateCombinedPosSettlement,
  resolvePosCustomerMatch,
} from '../src/utils/qrisFee';
import { computeCashierClosingBreakdown } from '../src/utils/cashierClosing';

const fakeTs = {} as Timestamp;

function makeCustomer(overrides: Partial<Customer> & { id: string; name: string }): Customer {
  return {
    id: overrides.id,
    name: overrides.name,
    phone: overrides.phone,
    totalDebt: overrides.totalDebt ?? 0,
    createdByUid: 'u1',
    createdAt: fakeTs,
    updatedAt: fakeTs,
  };
}

test('resolvePosCustomerMatch detects existing customers case-insensitively and flags new names', () => {
  const customers: Customer[] = [
    makeCustomer({ id: 'c1', name: 'Ibu Rina', totalDebt: 45000 }),
    makeCustomer({ id: 'c2', name: 'Pak Budi', totalDebt: 0 }),
  ];

  // Empty or Umum -> walk-in without creating customer
  assert.deepEqual(resolvePosCustomerMatch(customers, ''), {
    matchedCustomer: null,
    isNewCustomer: false,
    cleanName: '',
  });
  assert.deepEqual(resolvePosCustomerMatch(customers, '  Umum  '), {
    matchedCustomer: null,
    isNewCustomer: false,
    cleanName: '',
  });

  // Case-insensitive match binds registered customer
  const matched = resolvePosCustomerMatch(customers, '  ibu rina ');
  assert.equal(matched.matchedCustomer?.id, 'c1');
  assert.equal(matched.isNewCustomer, false);
  assert.equal(matched.cleanName, 'Ibu Rina');

  // Brand-new name -> flagged for automatic customer creation
  const brandNew = resolvePosCustomerMatch(customers, '  Pak Anton  ');
  assert.equal(brandNew.matchedCustomer, null);
  assert.equal(brandNew.isNewCustomer, true);
  assert.equal(brandNew.cleanName, 'Pak Anton');
});

test('calculateCombinedPosSettlement handles cash checkout + full simultaneous debt repayment', () => {
  const res = calculateCombinedPosSettlement({
    saleTotalAmount: 35000,
    paymentMethod: 'cash',
    paidAmount: 100000,
    qrisFeePercent: 0.3,
    customerPrevDebt: 50000,
    receivablePayAmount: 50000,
  });

  assert.equal(res.grandTotalDue, 85000);
  assert.equal(res.grandPaidAmount, 100000);
  assert.equal(res.grandChangeAmount, 15000);
  assert.equal(res.saleSettlement.cashDepositAmount, 35000);
  assert.equal(res.receivablePaidAmount, 50000);
  assert.equal(res.receivableCashIn, 50000);
  assert.equal(res.receivableQrisIn, 0);
  assert.equal(res.customerDebtBefore, 50000);
  assert.equal(res.customerDebtAfter, 0);
});

test('calculateCombinedPosSettlement keeps QRIS MDR fee isolated to shopping total while paying partial debt', () => {
  const res = calculateCombinedPosSettlement({
    saleTotalAmount: 20000,
    paymentMethod: 'qris',
    paidAmount: 50000,
    qrisFeePercent: 0.3,
    customerPrevDebt: 80000,
    receivablePayAmount: 30000,
  });

  assert.equal(res.grandTotalDue, 50000);
  assert.equal(res.grandChangeAmount, 0);
  assert.equal(res.saleSettlement.qrisAmount, 20000);
  assert.equal(res.saleSettlement.qrisFeeAmount, 60);
  assert.equal(res.saleSettlement.qrisNetDepositAmount, 19940);
  assert.equal(res.receivableQrisIn, 30000);
  assert.equal(res.receivableCashIn, 0);
  assert.equal(res.customerDebtAfter, 50000);
});

test('calculateCombinedPosSettlement handles mixed Tunai + QRIS across shopping + debt payment', () => {
  // Shopping 20.000 + Debt 50.000 = 70.000. Customer pays QRIS 40.000 + Tunai 40.000 = 80.000 (Change 10.000)
  const res = calculateCombinedPosSettlement({
    saleTotalAmount: 20000,
    paymentMethod: 'mixed',
    paidAmount: 80000,
    qrisPart: 40000,
    cashPart: 40000,
    qrisFeePercent: 0.3,
    customerPrevDebt: 50000,
    receivablePayAmount: 50000,
  });

  assert.equal(res.grandTotalDue, 70000);
  assert.equal(res.grandPaidAmount, 80000);
  assert.equal(res.grandChangeAmount, 10000);
  assert.equal(res.saleSettlement.qrisAmount, 20000);
  assert.equal(res.saleSettlement.cashPaidPart, 0);
  assert.equal(res.saleSettlement.qrisFeeAmount, 60);
  assert.equal(res.receivableQrisIn, 20000);
  assert.equal(res.receivableCashIn, 30000);
  assert.equal(res.customerDebtAfter, 0);
});

test('calculateCombinedPosSettlement validates overpayment of debt and kasbon conflicts', () => {
  assert.throws(
    () =>
      calculateCombinedPosSettlement({
        saleTotalAmount: 25000,
        paymentMethod: 'cash',
        paidAmount: 100000,
        qrisFeePercent: 0.3,
        customerPrevDebt: 30000,
        receivablePayAmount: 40000,
      }),
    /melebihi/i
  );

  assert.throws(
    () =>
      calculateCombinedPosSettlement({
        saleTotalAmount: 25000,
        paymentMethod: 'debt',
        paidAmount: 0,
        qrisFeePercent: 0.3,
        customerPrevDebt: 30000,
        receivablePayAmount: 10000,
      }),
    /Kasbon/i
  );

  const kasbonWithPrev = calculateCombinedPosSettlement({
    saleTotalAmount: 25000,
    paymentMethod: 'debt',
    paidAmount: 5000,
    qrisFeePercent: 0.3,
    customerPrevDebt: 30000,
    receivablePayAmount: 0,
  });
  assert.equal(kasbonWithPrev.saleSettlement.debtAmount, 20000);
  assert.equal(kasbonWithPrev.customerDebtAfter, 50000);
});

test('Closing Kasir reconciles pure retail sales separately from simultaneous receivable payments without double-counting', () => {
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
      name: 'Bank QRIS',
      type: 'bank',
      balance: 0,
      isActive: true,
      updatedByUid: 'u1',
      createdAt: fakeTs,
      updatedAt: fakeTs,
    },
  ];

  const combined = calculateCombinedPosSettlement({
    saleTotalAmount: 30000,
    paymentMethod: 'mixed',
    paidAmount: 80000,
    qrisPart: 45000,
    cashPart: 35000,
    qrisFeePercent: 0.3,
    customerPrevDebt: 50000,
    receivablePayAmount: 50000,
  });

  const sale: Sale = {
    id: 'sale1',
    transactionNumber: 'POS-001',
    transactionDate: '2026-11-18',
    transactionTime: '10:00:00',
    customerId: 'c1',
    customerName: 'Ibu Rina',
    totalItems: 2,
    subtotal: 30000,
    discount: 0,
    totalAmount: 30000,
    paidAmount: combined.grandPaidAmount,
    changeAmount: combined.grandChangeAmount,
    debtAmount: 0,
    receivablePaidAmount: combined.receivablePaidAmount,
    customerDebtBefore: combined.customerDebtBefore,
    customerDebtAfter: combined.customerDebtAfter,
    paymentMethod: 'mixed',
    cashPaidPart: combined.saleSettlement.cashPaidPart,
    qrisAmount: combined.saleSettlement.qrisAmount,
    qrisFeeRate: combined.saleSettlement.qrisFeeRate,
    qrisFeeAmount: combined.saleSettlement.qrisFeeAmount,
    netReceivedAmount: combined.saleSettlement.netReceivedAmount,
    accountId: 'acc_cash',
    qrisAccountId: 'acc_bank',
    status: 'completed',
    recordedByUid: 'kasir1',
    recordedByName: 'Kasir 1',
    createdAt: fakeTs,
    updatedAt: fakeTs,
  };

  const receivables: Receivable[] = [
    {
      id: 'recp_cash',
      transactionNumber: 'BYP-001-T',
      transactionDate: '2026-11-18',
      transactionTime: '10:00:00',
      customerId: 'c1',
      customerName: 'Ibu Rina',
      type: 'payment',
      amount: combined.receivableCashIn,
      balanceAfter: 15000,
      saleId: 'sale1',
      accountId: 'acc_cash',
      recordedByUid: 'kasir1',
      recordedByName: 'Kasir 1',
      createdAt: fakeTs,
    },
    {
      id: 'recp_qris',
      transactionNumber: 'BYP-001-Q',
      transactionDate: '2026-11-18',
      transactionTime: '10:00:00',
      customerId: 'c1',
      customerName: 'Ibu Rina',
      type: 'payment',
      amount: combined.receivableQrisIn,
      balanceAfter: 0,
      saleId: 'sale1',
      accountId: 'acc_bank',
      recordedByUid: 'kasir1',
      recordedByName: 'Kasir 1',
      createdAt: fakeTs,
    },
  ];

  const closing = computeCashierClosingBreakdown({
    sales: [sale],
    miniAtmTransactions: [],
    ppobTransactions: [],
    receivables,
    accounts,
    targetCashierUid: 'kasir1',
    periodStartDate: '2026-11-18',
    periodEndDate: '2026-11-18',
    openingCash: 100000,
  });

  assert.equal(closing.totalSalesAmount, 30000);
  assert.equal(closing.retailCashIn, 0);
  assert.equal(closing.retailQrisTotal, 30000);
  assert.equal(closing.receivableCashIn, 35000);
  assert.equal(closing.receivableNonCashIn, 15000);
  assert.equal(closing.expectedCash, 135000);
  assert.equal(closing.totalNonCashAmount, 45000);
});
