import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type { Account, Customer, Receivable } from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import { createTransactionMetadata, generateSafeId } from '../utils/formatters';
import { roundMoney } from '../utils/unitConversion';

export function subscribeCustomers(
  onData: (customers: Customer[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'customers'), orderBy('name', 'asc'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: Customer[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Customer, 'id'>),
      }));
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'customers');
    }
  );
}

export function subscribeReceivables(
  _isAdmin: boolean,
  _userUid: string,
  onData: (receivables: Receivable[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'receivables'));

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: Receivable[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Receivable, 'id'>),
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
      handleFirestoreError(error, OperationType.LIST, 'receivables');
    }
  );
}

export interface CreateCustomerPayload {
  name: string;
  phone?: string;
  address?: string;
  notes?: string;
  openingDebt?: number;
}

export async function createCustomer(
  payload: CreateCustomerPayload,
  user: { uid: string; displayName: string }
): Promise<Customer> {
  const cleanName = payload.name.trim().slice(0, 100);
  if (!cleanName) {
    throw new Error('Nama pelanggan wajib diisi.');
  }

  const openingDebt = roundMoney(Math.max(0, Number(payload.openingDebt) || 0));
  const customerId = generateSafeId('cst');
  const cleanPhone = (payload.phone || '').trim().slice(0, 24);
  const cleanAddress = (payload.address || '').trim().slice(0, 200);
  const cleanNotes = (payload.notes || '').trim().slice(0, 200);

  try {
    const batch = writeBatch(db);
    batch.set(doc(db, 'customers', customerId), {
      name: cleanName,
      ...(cleanPhone ? { phone: cleanPhone } : {}),
      ...(cleanAddress ? { address: cleanAddress } : {}),
      ...(cleanNotes ? { notes: cleanNotes } : {}),
      totalDebt: openingDebt,
      createdByUid: user.uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (openingDebt > 0) {
      const recId = generateSafeId('rec');
      const meta = createTransactionMetadata('KBN', user);
      batch.set(doc(db, 'receivables', recId), {
        ...meta,
        customerId,
        customerName: cleanName,
        type: 'debt',
        amount: openingDebt,
        balanceAfter: openingDebt,
        notes: 'Saldo piutang awal pelanggan',
        createdAt: serverTimestamp(),
      });
    }

    await batch.commit();

    return {
      id: customerId,
      name: cleanName,
      ...(cleanPhone ? { phone: cleanPhone } : {}),
      ...(cleanAddress ? { address: cleanAddress } : {}),
      ...(cleanNotes ? { notes: cleanNotes } : {}),
      totalDebt: openingDebt,
      createdByUid: user.uid,
      createdAt: undefined as never,
      updatedAt: undefined as never,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `customers/${customerId}`);
  }
}

export async function updateCustomer(
  customerId: string,
  payload: {
    name: string;
    phone?: string;
    address?: string;
    notes?: string;
  }
): Promise<void> {
  const cleanName = payload.name.trim().slice(0, 100);
  if (!cleanName) {
    throw new Error('Nama pelanggan wajib diisi.');
  }

  try {
    await updateDoc(doc(db, 'customers', customerId), {
      name: cleanName,
      phone: (payload.phone || '').trim().slice(0, 24),
      address: (payload.address || '').trim().slice(0, 200),
      notes: (payload.notes || '').trim().slice(0, 200),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `customers/${customerId}`);
  }
}

export async function deleteCustomer(customer: Customer): Promise<void> {
  if (Number(customer.totalDebt || 0) > 0) {
    throw new Error(
      `Pelanggan "${customer.name}" masih memiliki sisa piutang. Lunasi piutang terlebih dahulu sebelum menghapus.`
    );
  }
  try {
    await deleteDoc(doc(db, 'customers', customer.id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `customers/${customer.id}`);
  }
}

export async function recordManualDebt(
  payload: {
    customer: Customer;
    amount: number;
    notes?: string;
  },
  user: { uid: string; displayName: string }
): Promise<string> {
  const amount = roundMoney(Number(payload.amount) || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Nominal kasbon harus lebih dari Rp0.');
  }

  const currentDebt = roundMoney(Math.max(0, Number(payload.customer.totalDebt) || 0));
  const balanceAfter = roundMoney(currentDebt + amount);
  const recId = generateSafeId('rec');
  const meta = createTransactionMetadata('KBN', user);

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'customers', payload.customer.id), {
      totalDebt: balanceAfter,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'receivables', recId), {
      ...meta,
      customerId: payload.customer.id,
      customerName: payload.customer.name.slice(0, 100),
      type: 'debt',
      amount,
      balanceAfter,
      notes: (payload.notes?.trim() || 'Pencatatan kasbon manual').slice(0, 240),
      createdAt: serverTimestamp(),
    });
    await batch.commit();
    return meta.transactionNumber;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `receivables/${recId}`);
  }
}

export async function recordReceivablePayment(
  payload: {
    customer: Customer;
    amount: number;
    account: Account;
    notes?: string;
  },
  user: { uid: string; displayName: string }
): Promise<{ transactionNumber: string; balanceAfter: number }> {
  const amount = roundMoney(Number(payload.amount) || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('Nominal pembayaran harus lebih dari Rp0.');
  }

  const currentDebt = roundMoney(Math.max(0, Number(payload.customer.totalDebt) || 0));
  if (currentDebt <= 0) {
    throw new Error(`Pelanggan "${payload.customer.name}" tidak memiliki tunggakan piutang.`);
  }
  if (amount > currentDebt) {
    throw new Error('Nominal pembayaran tidak boleh melebihi sisa piutang pelanggan.');
  }

  const balanceAfter = Math.max(0, roundMoney(currentDebt - amount));
  const accBalBefore = Number(payload.account.balance) || 0;
  const accBalAfter = roundMoney(accBalBefore + amount);

  const recId = generateSafeId('rec');
  const ledgerId = generateSafeId('ldg');
  const meta = createTransactionMetadata('BYR', user);

  try {
    const batch = writeBatch(db);
    batch.update(doc(db, 'customers', payload.customer.id), {
      totalDebt: balanceAfter,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'receivables', recId), {
      ...meta,
      customerId: payload.customer.id,
      customerName: payload.customer.name.slice(0, 100),
      type: 'payment',
      amount,
      balanceAfter,
      accountId: payload.account.id,
      notes: (
        payload.notes?.trim() ||
        (balanceAfter === 0
          ? `Pelunasan piutang ke ${payload.account.name}`
          : `Cicilan piutang ke ${payload.account.name}`)
      ).slice(0, 240),
      createdAt: serverTimestamp(),
    });
    batch.update(doc(db, 'accounts', payload.account.id), {
      balance: accBalAfter,
      updatedByUid: user.uid,
      updatedAt: serverTimestamp(),
    });
    batch.set(doc(db, 'cash_ledger', ledgerId), {
      ...meta,
      accountId: payload.account.id,
      accountName: payload.account.name.slice(0, 80),
      direction: 'in',
      amount,
      balanceBefore: accBalBefore,
      balanceAfter: accBalAfter,
      sourceModule: 'receivable',
      referenceId: recId,
      description: `Pembayaran piutang ${payload.customer.name} (${meta.transactionNumber})`.slice(
        0,
        240
      ),
      createdAt: serverTimestamp(),
    });

    await batch.commit();
    return {
      transactionNumber: meta.transactionNumber,
      balanceAfter,
    };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `receivables/${recId}`);
  }
}
