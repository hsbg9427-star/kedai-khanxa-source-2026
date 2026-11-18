import {
  doc,
  runTransaction,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Account, Expense } from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import { createTransactionMetadata, formatRupiah, generateSafeId } from '../utils/formatters';
import { roundMoney } from '../utils/unitConversion';

function isOfflineTransactionError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = (error as { code?: string })?.code || '';
  return code === 'unavailable' || code === 'failed-precondition';
}

export const EXPENSE_CATEGORIES = [
  'Listrik & Air',
  'Internet / WiFi',
  'Plastik & Kemasan',
  'Transportasi / Bensin',
  'Gaji / Upah Karyawan',
  'Sewa & Perawatan Toko',
  'Perlengkapan Toko',
  'Lainnya',
];

export interface RecordExpenseInput {
  category: string;
  description: string;
  amount: number;
  account: Account;
}

export async function recordExpense(
  input: RecordExpenseInput,
  user: { uid: string; displayName: string }
): Promise<{ expenseId: string; transactionNumber: string }> {
  const cleanCategory = input.category.trim().slice(0, 60);
  const cleanDescription = input.description.trim().slice(0, 240);
  const cleanAmount = roundMoney(Number(input.amount) || 0);

  if (!cleanCategory) {
    throw new Error('Kategori pengeluaran wajib diisi.');
  }
  if (!cleanDescription) {
    throw new Error('Keterangan pengeluaran wajib diisi.');
  }
  if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
    throw new Error('Nominal pengeluaran harus lebih dari Rp0.');
  }
  if (!input.account.isActive) {
    throw new Error(`Akun "${input.account.name}" sedang nonaktif.`);
  }

  const expenseId = generateSafeId('exp');
  const ledgerId = generateSafeId('ldg');
  const meta = createTransactionMetadata('EXP', user);

  const expRef = doc(db, 'expenses', expenseId);
  const accRef = doc(db, 'accounts', input.account.id);
  const ledgerRef = doc(db, 'cash_ledger', ledgerId);

  const applyWrites = (
    accData: Pick<Account, 'name' | 'balance'>,
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    }
  ) => {
    const balBefore = roundMoney(Number(accData.balance) || 0);
    if (balBefore < cleanAmount) {
      throw new Error(
        `Saldo ${accData.name} (${formatRupiah(balBefore)}) tidak mencukupi untuk pengeluaran ${formatRupiah(
          cleanAmount
        )}.`
      );
    }
    const balAfter = roundMoney(balBefore - cleanAmount);

    writer.update(accRef, {
      balance: balAfter,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });
    writer.set(expRef, {
      ...meta,
      category: cleanCategory,
      description: cleanDescription,
      amount: cleanAmount,
      accountId: input.account.id,
      accountName: accData.name.slice(0, 80),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    writer.set(ledgerRef, {
      ...meta,
      accountId: input.account.id,
      accountName: accData.name.slice(0, 80),
      direction: 'out',
      amount: cleanAmount,
      balanceBefore: balBefore,
      balanceAfter: balAfter,
      sourceModule: 'expense',
      referenceId: expenseId,
      description: `Pengeluaran ${cleanCategory}: ${cleanDescription}`.slice(0, 240),
      createdAt: serverTimestamp(),
    });
  };

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    applyWrites(input.account, {
      set: (ref, data) => batch.set(ref, data),
      update: (ref, data) => batch.update(ref, data),
    });
    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const accSnap = await tx.get(accRef);
          if (!accSnap.exists()) {
            throw new Error('Akun sumber dana tidak ditemukan.');
          }
          applyWrites(accSnap.data() as Account, {
            set: (ref, data) => tx.set(ref, data),
            update: (ref, data) => tx.update(ref, data),
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
      expenseId,
      transactionNumber: meta.transactionNumber,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `expenses/${expenseId}`);
  }
}

export async function deleteExpenseAndRestoreAccount(
  expense: Expense,
  accounts: Account[],
  user: { uid: string; displayName: string }
): Promise<void> {
  const cleanAmount = roundMoney(Number(expense.amount) || 0);
  const expRef = doc(db, 'expenses', expense.id);
  const accRef = doc(db, 'accounts', expense.accountId);
  const ledgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));
  const meta = createTransactionMetadata('REXP', user);

  const applyWrites = (
    accData: Pick<Account, 'name' | 'balance'> | null,
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      delete: (ref: ReturnType<typeof doc>) => void;
    }
  ) => {
    writer.delete(expRef);
    if (accData && cleanAmount > 0) {
      const balBefore = roundMoney(Number(accData.balance) || 0);
      const balAfter = roundMoney(balBefore + cleanAmount);
      writer.update(accRef, {
        balance: balAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
      writer.set(ledgerRef, {
        ...meta,
        accountId: expense.accountId,
        accountName: accData.name.slice(0, 80),
        direction: 'in',
        amount: cleanAmount,
        balanceBefore: balBefore,
        balanceAfter: balAfter,
        sourceModule: 'expense',
        referenceId: expense.id,
        description: `Pembatalan pengeluaran ${expense.transactionNumber} (${expense.category})`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }
  };

  const executeOfflineBatch = async () => {
    const acc = accounts.find((a) => a.id === expense.accountId) || null;
    const batch = writeBatch(db);
    applyWrites(acc, {
      set: (ref, data) => batch.set(ref, data),
      update: (ref, data) => batch.update(ref, data),
      delete: (ref) => batch.delete(ref),
    });
    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const [expSnap, accSnap] = await Promise.all([tx.get(expRef), tx.get(accRef)]);
          if (!expSnap.exists()) {
            throw new Error('Catatan pengeluaran tidak ditemukan atau sudah dihapus.');
          }
          applyWrites(accSnap.exists() ? (accSnap.data() as Account) : null, {
            set: (ref, data) => tx.set(ref, data),
            update: (ref, data) => tx.update(ref, data),
            delete: (ref) => tx.delete(ref),
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
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.DELETE, `expenses/${expense.id}`);
  }
}

export interface TransferBetweenAccountsInput {
  fromAccount: Account;
  toAccount: Account;
  amount: number;
  notes?: string;
}

export async function transferBetweenAccounts(
  input: TransferBetweenAccountsInput,
  user: { uid: string; displayName: string }
): Promise<{ transactionNumber: string }> {
  const cleanAmount = roundMoney(Number(input.amount) || 0);
  if (input.fromAccount.id === input.toAccount.id) {
    throw new Error('Akun asal dan akun tujuan mutasi tidak boleh sama.');
  }
  if (!input.fromAccount.isActive || !input.toAccount.isActive) {
    throw new Error('Kedua akun mutasi harus dalam status aktif.');
  }
  if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
    throw new Error('Nominal pindah saldo harus lebih dari Rp0.');
  }

  const meta = createTransactionMetadata('TRF', user);
  const cleanNotes = (input.notes || '').trim();
  const fromRef = doc(db, 'accounts', input.fromAccount.id);
  const toRef = doc(db, 'accounts', input.toAccount.id);
  const outLedgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));
  const inLedgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));

  const applyWrites = (
    fromData: Pick<Account, 'name' | 'balance'>,
    toData: Pick<Account, 'name' | 'balance'>,
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    }
  ) => {
    const fromBefore = roundMoney(Number(fromData.balance) || 0);
    if (fromBefore < cleanAmount) {
      throw new Error(
        `Saldo ${fromData.name} (${formatRupiah(fromBefore)}) tidak mencukupi untuk pindah saldo ${formatRupiah(
          cleanAmount
        )}.`
      );
    }
    const fromAfter = roundMoney(fromBefore - cleanAmount);
    const toBefore = roundMoney(Number(toData.balance) || 0);
    const toAfter = roundMoney(toBefore + cleanAmount);

    writer.update(fromRef, {
      balance: fromAfter,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });
    writer.update(toRef, {
      balance: toAfter,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });

    const suffixNote = cleanNotes ? ` · ${cleanNotes}` : '';
    writer.set(outLedgerRef, {
      ...meta,
      transactionNumber: `${meta.transactionNumber}-OUT`.slice(0, 40),
      accountId: input.fromAccount.id,
      accountName: fromData.name.slice(0, 80),
      direction: 'out',
      amount: cleanAmount,
      balanceBefore: fromBefore,
      balanceAfter: fromAfter,
      sourceModule: 'transfer',
      referenceId: meta.transactionNumber,
      description: `Pindah saldo ke ${toData.name}${suffixNote}`.slice(0, 240),
      createdAt: serverTimestamp(),
    });
    writer.set(inLedgerRef, {
      ...meta,
      transactionNumber: `${meta.transactionNumber}-IN`.slice(0, 40),
      accountId: input.toAccount.id,
      accountName: toData.name.slice(0, 80),
      direction: 'in',
      amount: cleanAmount,
      balanceBefore: toBefore,
      balanceAfter: toAfter,
      sourceModule: 'transfer',
      referenceId: meta.transactionNumber,
      description: `Terima pindah saldo dari ${fromData.name}${suffixNote}`.slice(0, 240),
      createdAt: serverTimestamp(),
    });
  };

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    applyWrites(input.fromAccount, input.toAccount, {
      set: (ref, data) => batch.set(ref, data),
      update: (ref, data) => batch.update(ref, data),
    });
    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
          if (!fromSnap.exists() || !toSnap.exists()) {
            throw new Error('Akun asal atau tujuan tidak ditemukan.');
          }
          applyWrites(fromSnap.data() as Account, toSnap.data() as Account, {
            set: (ref, data) => tx.set(ref, data),
            update: (ref, data) => tx.update(ref, data),
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

    return { transactionNumber: meta.transactionNumber };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `accounts/${input.fromAccount.id}`);
  }
}

export async function recordCapitalAdjustment(
  input: {
    account: Account;
    direction: 'in' | 'out';
    amount: number;
    notes: string;
  },
  user: { uid: string; displayName: string }
): Promise<{ transactionNumber: string }> {
  const cleanAmount = roundMoney(Number(input.amount) || 0);
  const cleanNotes = input.notes.trim().slice(0, 200);
  if (!input.account.isActive) {
    throw new Error(`Akun "${input.account.name}" sedang nonaktif.`);
  }
  if (!Number.isFinite(cleanAmount) || cleanAmount <= 0) {
    throw new Error('Nominal modal / penyesuaian harus lebih dari Rp0.');
  }
  if (!cleanNotes) {
    throw new Error('Keterangan modal / penyesuaian wajib diisi.');
  }

  const meta = createTransactionMetadata('MDL', user);
  const accRef = doc(db, 'accounts', input.account.id);
  const ledgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));

  const applyWrites = (
    accData: Pick<Account, 'name' | 'balance'>,
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    }
  ) => {
    const balBefore = roundMoney(Number(accData.balance) || 0);
    const balAfter =
      input.direction === 'in'
        ? roundMoney(balBefore + cleanAmount)
        : roundMoney(balBefore - cleanAmount);
    if (balAfter < 0) {
      throw new Error(
        `Saldo ${accData.name} (${formatRupiah(balBefore)}) tidak mencukupi untuk penarikan ${formatRupiah(
          cleanAmount
        )}.`
      );
    }

    writer.update(accRef, {
      balance: balAfter,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });
    writer.set(ledgerRef, {
      ...meta,
      accountId: input.account.id,
      accountName: accData.name.slice(0, 80),
      direction: input.direction,
      amount: cleanAmount,
      balanceBefore: balBefore,
      balanceAfter: balAfter,
      sourceModule: 'capital',
      referenceId: meta.transactionNumber,
      description: `${input.direction === 'in' ? 'Tambah Modal' : 'Tarik Modal / Prive'}: ${cleanNotes}`.slice(
        0,
        240
      ),
      createdAt: serverTimestamp(),
    });
  };

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    applyWrites(input.account, {
      set: (ref, data) => batch.set(ref, data),
      update: (ref, data) => batch.update(ref, data),
    });
    await batch.commit();
  };

  try {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      await executeOfflineBatch();
    } else {
      try {
        await runTransaction(db, async (tx) => {
          const accSnap = await tx.get(accRef);
          if (!accSnap.exists()) {
            throw new Error('Akun kas/rekening tidak ditemukan.');
          }
          applyWrites(accSnap.data() as Account, {
            set: (ref, data) => tx.set(ref, data),
            update: (ref, data) => tx.update(ref, data),
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

    return { transactionNumber: meta.transactionNumber };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `accounts/${input.account.id}`);
  }
}
