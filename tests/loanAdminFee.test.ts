import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp } from 'firebase/firestore';
import type { Account, Loan, LoanPayment } from '../src/types/database';
import {
  buildFinancialAndQrisReport,
  getLoanAdminFeeState,
  getLoanDisplayStatus,
  getLoanPaymentBreakdown,
} from '../src/utils/qrisFee';

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

test('Pinjaman dengan biaya admin fleksibel: admin belum lunas saat pokok lunas ditandai menunggu admin & boleh dibayar setelah pengembalian', () => {
  const loanFlexible: Loan = {
    id: 'loan_flex',
    transactionNumber: 'PJM-001',
    transactionDate: '2026-11-18',
    transactionTime: '09:00:00',
    borrowerName: 'Pak Budi',
    loanDate: '2026-11-18',
    dueDate: '2026-12-18',
    principalAmount: 200000,
    paidAmount: 200000,
    remainingAmount: 0,
    adminFee: 0,
    adminFeePaid: 0,
    sourceAccountId: CASH_ACC.id,
    sourceAccountName: CASH_ACC.name,
    sourceAccountType: 'cash',
    status: 'paid',
    recordedByUid: 'admin_1',
    recordedByName: 'Admin',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };

  const flexState = getLoanAdminFeeState(loanFlexible);
  assert.equal(flexState.isFlexible, true);
  assert.equal(flexState.isPrincipalPaidOff, true);
  assert.equal(flexState.needsAdminPayment, false);
  assert.equal(getLoanDisplayStatus(loanFlexible, '2026-11-20'), 'Lunas');

  const loanWithTarget: Loan = {
    ...loanFlexible,
    id: 'loan_target',
    adminFee: 15000,
    adminFeePaid: 0,
  };
  const targetState = getLoanAdminFeeState(loanWithTarget);
  assert.equal(targetState.isFlexible, false);
  assert.equal(targetState.remainingTargetAdminFee, 15000);
  assert.equal(targetState.needsAdminPayment, true);

  const loanAfterAdminPaid: Loan = {
    ...loanWithTarget,
    adminFeePaid: 15000,
  };
  assert.equal(getLoanAdminFeeState(loanAfterAdminPaid).needsAdminPayment, false);
});

test('Laporan keuangan memisahkan pengembalian pokok (non-laba) dan biaya admin pinjaman (laba jasa) serta kompatibel dengan riwayat lama', () => {
  const loan: Loan = {
    id: 'loan_1',
    transactionNumber: 'PJM-001',
    transactionDate: '2026-11-18',
    transactionTime: '09:00:00',
    borrowerName: 'Pak Budi',
    loanDate: '2026-11-18',
    dueDate: '2026-12-18',
    principalAmount: 300000,
    paidAmount: 300000,
    remainingAmount: 0,
    adminFee: 0,
    adminFeePaid: 20000,
    sourceAccountId: CASH_ACC.id,
    sourceAccountName: CASH_ACC.name,
    sourceAccountType: 'cash',
    status: 'paid',
    recordedByUid: 'admin_1',
    recordedByName: 'Admin',
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  };

  // Pembayaran 1: format lama tanpa principalPaid/adminFeePaid (100% dianggap pokok)
  const legacyPayment: LoanPayment = {
    id: 'lpm_legacy',
    transactionNumber: 'CLN-001',
    transactionDate: '2026-11-18',
    transactionTime: '10:00:00',
    loanId: loan.id,
    loanNumber: loan.transactionNumber,
    borrowerName: loan.borrowerName,
    amount: 100000,
    remainingBefore: 300000,
    remainingAfter: 200000,
    accountId: CASH_ACC.id,
    accountName: CASH_ACC.name,
    recordedByUid: 'admin_1',
    recordedByName: 'Admin',
    createdAt: Timestamp.now(),
  };

  // Pembayaran 2: pelunasan pokok Rp200.000
  const payoffPrincipal: LoanPayment = {
    id: 'lpm_principal',
    transactionNumber: 'CLN-002',
    transactionDate: '2026-11-18',
    transactionTime: '11:00:00',
    loanId: loan.id,
    loanNumber: loan.transactionNumber,
    borrowerName: loan.borrowerName,
    amount: 200000,
    principalPaid: 200000,
    adminFeePaid: 0,
    remainingBefore: 200000,
    remainingAfter: 0,
    accountId: CASH_ACC.id,
    accountName: CASH_ACC.name,
    recordedByUid: 'admin_1',
    recordedByName: 'Admin',
    createdAt: Timestamp.now(),
  };

  // Pembayaran 3: biaya admin fleksibel Rp20.000 dibayar SETELAH pokok lunas
  const postRepaymentAdmin: LoanPayment = {
    id: 'lpm_admin',
    transactionNumber: 'CLN-003',
    transactionDate: '2026-11-18',
    transactionTime: '12:00:00',
    loanId: loan.id,
    loanNumber: loan.transactionNumber,
    borrowerName: loan.borrowerName,
    amount: 20000,
    principalPaid: 0,
    adminFeePaid: 20000,
    remainingBefore: 0,
    remainingAfter: 0,
    accountId: CASH_ACC.id,
    accountName: CASH_ACC.name,
    recordedByUid: 'admin_1',
    recordedByName: 'Admin',
    createdAt: Timestamp.now(),
  };

  assert.deepEqual(getLoanPaymentBreakdown(legacyPayment), {
    totalAmount: 100000,
    principalPaid: 100000,
    adminFeePaid: 0,
  });
  assert.deepEqual(getLoanPaymentBreakdown(postRepaymentAdmin), {
    totalAmount: 20000,
    principalPaid: 0,
    adminFeePaid: 20000,
  });

  const report = buildFinancialAndQrisReport({
    periodType: 'daily',
    anchorDateStr: '2026-11-18',
    todayDateStr: '2026-11-18',
    sales: [],
    loans: [loan],
    loanPayments: [legacyPayment, payoffPrincipal, postRepaymentAdmin],
    customers: [],
    accounts: [CASH_ACC],
  });

  assert.equal(report.loansDisbursedInPeriod, 300000);
  assert.equal(report.loanPaymentsInPeriod, 300000); // Hanya pokok (non-laba)
  assert.equal(report.loanAdminFeesInPeriod, 20000); // Hanya biaya admin
  assert.equal(report.totalLoansAdminFeePaidAllTime, 20000);
  assert.equal(report.netOperatingProfit, 20000); // Biaya admin dihitung sebagai pendapatan bersih
});
