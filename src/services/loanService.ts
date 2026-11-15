import {
  collection,
  doc,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Account, Loan, LoanPayment } from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import { createTransactionMetadata, formatRupiah, generateSafeId } from '../utils/formatters';
import { roundMoney } from '../utils/unitConversion';

function isOfflineTransactionError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = (error as { code?: string })?.code || '';
  return code === 'unavailable' || code === 'failed-precondition';
}

export function subscribeLoans(
  onData: (loans: Loan[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'loans'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: Loan[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Loan, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.loanDate || a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.loanDate || b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'loans');
    }
  );
}

export function subscribeLoanPayments(
  onData: (payments: LoanPayment[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'loan_payments'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: LoanPayment[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<LoanPayment, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list.slice(0, 300), snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'loan_payments');
    }
  );
}

export interface CreateLoanDisbursementInput {
  borrowerName: string;
  borrowerPhone?: string;
  principalAmount: number;
  loanDate: string;
  dueDate: string;
  sourceAccount: Account;
  notes?: string;
}

export async function createLoanDisbursement(
  input: CreateLoanDisbursementInput,
  user: { uid: string; displayName: string }
): Promise<{ loanId: string; transactionNumber: string }> {
  const cleanName = input.borrowerName.trim().slice(0, 100);
  if (!cleanName) {
    throw new Error('Nama peminjam wajib diisi.');
  }

  const cleanAmount = roundMoney(Number(input.principalAmount) || 0);
  if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
    throw new Error('Jumlah pinjaman harus lebih dari Rp0.');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.loanDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate)) {
    throw new Error('Tanggal pinjaman dan jatuh tempo harus berformat YYYY-MM-DD.');
  }

  if (input.dueDate < input.loanDate) {
    throw new Error('Tanggal jatuh tempo tidak boleh lebih awal dari tanggal pinjaman.');
  }

  if (!input.sourceAccount.isActive) {
    throw new Error(`Akun "${input.sourceAccount.name}" sedang nonaktif.`);
  }

  const loanId = generateSafeId('loan');
  const ledgerId = generateSafeId('ldg');
  const meta = createTransactionMetadata('PJM', user);
  const cleanPhone = (input.borrowerPhone || '').trim().slice(0, 24);
  const cleanNotes = (input.notes || '').trim().slice(0, 240);

  const loanRef = doc(db, 'loans', loanId);
  const accountRef = doc(db, 'accounts', input.sourceAccount.id);
  const ledgerRef = doc(db, 'cash_ledger', ledgerId);

  const executeOfflineBatch = async () => {
    const balBefore = roundMoney(Number(input.sourceAccount.balance) || 0);
    if (balBefore < cleanAmount) {
      throw new Error(
        `Saldo ${input.sourceAccount.name} (${formatRupiah(balBefore)}) tidak mencukupi untuk pinjaman ${formatRupiah(
          cleanAmount
        )}.`
      );
    }
    const balAfter = roundMoney(balBefore - cleanAmount);

    const batch = writeBatch(db);
    batch.update(accountRef, {
      balance: balAfter,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });
    batch.set(loanRef, {
      ...meta,
      borrowerName: cleanName,
      ...(cleanPhone ? { borrowerPhone: cleanPhone } : {}),
      loanDate: input.loanDate,
      dueDate: input.dueDate,
      principalAmount: cleanAmount,
      paidAmount: 0,
      remainingAmount: cleanAmount,
      sourceAccountId: input.sourceAccount.id,
      sourceAccountName: input.sourceAccount.name.slice(0, 80),
      sourceAccountType: input.sourceAccount.type,
      status: 'unpaid',
      ...(cleanNotes ? { notes: cleanNotes } : {}),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    batch.set(ledgerRef, {
      ...meta,
      accountId: input.sourceAccount.id,
      accountName: input.sourceAccount.name.slice(0, 80),
      direction: 'out',
      amount: cleanAmount,
      balanceBefore: balBefore,
      balanceAfter: balAfter,
      sourceModule: 'loan',
      referenceId: loanId,
      description: `Pinjaman uang a.n. ${cleanName} (${meta.transactionNumber})`.slice(0, 240),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const accSnap = await tx.get(accountRef);
          if (!accSnap.exists()) {
            throw new Error('Akun sumber dana tidak ditemukan.');
          }
          const accData = accSnap.data() as Account;
          const balBefore = roundMoney(Number(accData.balance) || 0);
          if (balBefore < cleanAmount) {
            throw new Error(
              `Saldo ${accData.name} (${formatRupiah(balBefore)}) tidak mencukupi untuk pinjaman ${formatRupiah(
                cleanAmount
              )}.`
            );
          }
          const balAfter = roundMoney(balBefore - cleanAmount);

          tx.update(accountRef, {
            balance: balAfter,
            updatedByUid: user.uid,
            updatedAt: serverTimestamp(),
          });
          tx.set(loanRef, {
            ...meta,
            borrowerName: cleanName,
            ...(cleanPhone ? { borrowerPhone: cleanPhone } : {}),
            loanDate: input.loanDate,
            dueDate: input.dueDate,
            principalAmount: cleanAmount,
            paidAmount: 0,
            remainingAmount: cleanAmount,
            sourceAccountId: input.sourceAccount.id,
            sourceAccountName: accData.name.slice(0, 80),
            sourceAccountType: accData.type,
            status: 'unpaid',
            ...(cleanNotes ? { notes: cleanNotes } : {}),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          tx.set(ledgerRef, {
            ...meta,
            accountId: input.sourceAccount.id,
            accountName: accData.name.slice(0, 80),
            direction: 'out',
            amount: cleanAmount,
            balanceBefore: balBefore,
            balanceAfter: balAfter,
            sourceModule: 'loan',
            referenceId: loanId,
            description: `Pinjaman uang a.n. ${cleanName} (${meta.transactionNumber})`.slice(0, 240),
            createdAt: serverTimestamp(),
          });
        });
      } catch (err) {
        if (isOfflineTransactionError(err)) {
          await executeOfflineBatch();
        } else {
          throw err;
        }
      }
    }

    return {
      loanId,
      transactionNumber: meta.transactionNumber,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `loans/${loanId}`);
  }
}

export interface RecordLoanInstallmentInput {
  loan: Loan;
  amount: number;
  destinationAccount: Account;
  notes?: string;
}

export async function recordLoanInstallment(
  input: RecordLoanInstallmentInput,
  user: { uid: string; displayName: string }
): Promise<{
  paymentId: string;
  transactionNumber: string;
  remainingAfter: number;
  newStatus: 'unpaid' | 'partial' | 'paid';
}> {
  const cleanAmount = roundMoney(Number(input.amount) || 0);
  if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
    throw new Error('Nominal pembayaran cicilan harus lebih dari Rp0.');
  }

  if (!input.destinationAccount.isActive) {
    throw new Error(`Akun tujuan "${input.destinationAccount.name}" sedang nonaktif.`);
  }

  const paymentId = generateSafeId('lpm');
  const ledgerId = generateSafeId('ldg');
  const meta = createTransactionMetadata('CLN', user);
  const cleanNotes = (input.notes || '').trim().slice(0, 240);

  const loanRef = doc(db, 'loans', input.loan.id);
  const paymentRef = doc(db, 'loan_payments', paymentId);
  const accountRef = doc(db, 'accounts', input.destinationAccount.id);
  const ledgerRef = doc(db, 'cash_ledger', ledgerId);

  let finalRemaining = 0;
  let finalStatus: 'unpaid' | 'partial' | 'paid' = 'partial';

  const executeOfflineBatch = async () => {
    const remainingBefore = roundMoney(Math.max(0, Number(input.loan.remainingAmount) || 0));
    if (remainingBefore <= 0) {
      throw new Error(`Pinjaman "${input.loan.borrowerName}" sudah lunas.`);
    }
    if (cleanAmount > remainingBefore) {
      throw new Error(
        `Pembayaran ${formatRupiah(cleanAmount)} melebihi sisa pinjaman ${formatRupiah(
          remainingBefore
        )}.`
      );
    }

    const paidAfter = roundMoney((Number(input.loan.paidAmount) || 0) + cleanAmount);
    finalRemaining = roundMoney(Math.max(0, remainingBefore - cleanAmount));
    finalStatus = finalRemaining <= 0 ? 'paid' : 'partial';

    const balBefore = roundMoney(Number(input.destinationAccount.balance) || 0);
    const balAfter = roundMoney(balBefore + cleanAmount);

    const batch = writeBatch(db);
    batch.update(loanRef, {
      paidAmount: paidAfter,
      remainingAmount: finalRemaining,
      status: finalStatus,
      updatedAt: serverTimestamp(),
    });
    batch.set(paymentRef, {
      ...meta,
      loanId: input.loan.id,
      loanNumber: input.loan.transactionNumber,
      borrowerName: input.loan.borrowerName.slice(0, 100),
      amount: cleanAmount,
      remainingBefore,
      remainingAfter: finalRemaining,
      accountId: input.destinationAccount.id,
      accountName: input.destinationAccount.name.slice(0, 80),
      notes: (
        cleanNotes ||
        (finalRemaining === 0
          ? `Pelunasan pinjaman ke ${input.destinationAccount.name}`
          : `Cicilan pinjaman ke ${input.destinationAccount.name}`)
      ).slice(0, 240),
      createdAt: serverTimestamp(),
    });
    batch.update(accountRef, {
      balance: balAfter,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });
    batch.set(ledgerRef, {
      ...meta,
      accountId: input.destinationAccount.id,
      accountName: input.destinationAccount.name.slice(0, 80),
      direction: 'in',
      amount: cleanAmount,
      balanceBefore: balBefore,
      balanceAfter: balAfter,
      sourceModule: 'loan',
      referenceId: paymentId,
      description: `${finalRemaining === 0 ? 'Pelunasan' : 'Cicilan'} pinjaman ${
        input.loan.borrowerName
      } (${meta.transactionNumber})`.slice(0, 240),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const [loanSnap, accSnap] = await Promise.all([tx.get(loanRef), tx.get(accountRef)]);
          if (!loanSnap.exists()) {
            throw new Error('Data pinjaman tidak ditemukan.');
          }
          if (!accSnap.exists()) {
            throw new Error('Akun tujuan penerimaan tidak ditemukan.');
          }

          const liveLoan = loanSnap.data() as Loan;
          const liveAcc = accSnap.data() as Account;

          const remainingBefore = roundMoney(Math.max(0, Number(liveLoan.remainingAmount) || 0));
          if (remainingBefore <= 0) {
            throw new Error(`Pinjaman "${liveLoan.borrowerName}" sudah lunas.`);
          }
          if (cleanAmount > remainingBefore) {
            throw new Error(
              `Pembayaran ${formatRupiah(cleanAmount)} melebihi sisa pinjaman ${formatRupiah(
                remainingBefore
              )}.`
            );
          }

          const paidAfter = roundMoney((Number(liveLoan.paidAmount) || 0) + cleanAmount);
          finalRemaining = roundMoney(Math.max(0, remainingBefore - cleanAmount));
          finalStatus = finalRemaining <= 0 ? 'paid' : 'partial';

          const balBefore = roundMoney(Number(liveAcc.balance) || 0);
          const balAfter = roundMoney(balBefore + cleanAmount);

          tx.update(loanRef, {
            paidAmount: paidAfter,
            remainingAmount: finalRemaining,
            status: finalStatus,
            updatedAt: serverTimestamp(),
          });
          tx.set(paymentRef, {
            ...meta,
            loanId: input.loan.id,
            loanNumber: liveLoan.transactionNumber,
            borrowerName: liveLoan.borrowerName.slice(0, 100),
            amount: cleanAmount,
            remainingBefore,
            remainingAfter: finalRemaining,
            accountId: input.destinationAccount.id,
            accountName: liveAcc.name.slice(0, 80),
            notes: (
              cleanNotes ||
              (finalRemaining === 0
                ? `Pelunasan pinjaman ke ${liveAcc.name}`
                : `Cicilan pinjaman ke ${liveAcc.name}`)
            ).slice(0, 240),
            createdAt: serverTimestamp(),
          });
          tx.update(accountRef, {
            balance: balAfter,
            updatedByUid: user.uid,
            updatedAt: serverTimestamp(),
          });
          tx.set(ledgerRef, {
            ...meta,
            accountId: input.destinationAccount.id,
            accountName: liveAcc.name.slice(0, 80),
            direction: 'in',
            amount: cleanAmount,
            balanceBefore: balBefore,
            balanceAfter: balAfter,
            sourceModule: 'loan',
            referenceId: paymentId,
            description: `${finalRemaining === 0 ? 'Pelunasan' : 'Cicilan'} pinjaman ${
              liveLoan.borrowerName
            } (${meta.transactionNumber})`.slice(0, 240),
            createdAt: serverTimestamp(),
          });
        });
      } catch (err) {
        if (isOfflineTransactionError(err)) {
          await executeOfflineBatch();
        } else {
          throw err;
        }
      }
    }

    return {
      paymentId,
      transactionNumber: meta.transactionNumber,
      remainingAfter: finalRemaining,
      newStatus: finalStatus,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `loan_payments/${paymentId}`);
  }
}
