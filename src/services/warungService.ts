import {
  collection,
  deleteDoc,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  Account,
  AccountType,
  CashLedger,
  Expense,
  MiniAtmTransaction,
  PpobTransaction,
  Sale,
  StaffInvite,
  StoreSetting,
  UserProfile,
  UserRole,
  UserStatus,
} from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import { generateSafeId } from '../utils/formatters';
import { DEFAULT_QRIS_FEE_PERCENT } from '../utils/qrisFee';

export interface TodayDashboardMetrics {
  retailSalesTotal: number;
  retailProfitTotal: number;
  retailQrisFeeTotal: number;
  retailSalesCount: number;
  miniAtmVolumeTotal: number;
  miniAtmProfitTotal: number;
  miniAtmCount: number;
  ppobSalesTotal: number;
  ppobProfitTotal: number;
  ppobCount: number;
  expensesTotal: number;
  expensesCount: number;
  lowStockCount: number;
}

// 1. Pengaturan Warung
export function subscribeStoreSettings(
  onData: (setting: StoreSetting | null) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const ref = doc(db, 'store_settings', 'main');
  return onSnapshot(
    ref,
    (snap) => {
      onData(snap.exists() ? (snap.data() as StoreSetting) : null);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.GET, 'store_settings/main');
    }
  );
}

export async function saveStoreSettings(
  payload: {
    storeName: string;
    ownerName: string;
    address?: string;
    phone?: string;
    receiptHeader?: string;
    receiptThankYou?: string;
    receiptFooter?: string;
    qrisFeePercent?: number;
    hppMethod?: 'moving_average' | 'fifo';
    dailySalesTarget?: number;
  },
  uid: string
): Promise<void> {
  const ref = doc(db, 'store_settings', 'main');
  const rawFee = Number(payload.qrisFeePercent);
  const cleanQrisFee = Number.isFinite(rawFee)
    ? Math.max(0, Math.min(10, Number(rawFee.toFixed(4))))
    : DEFAULT_QRIS_FEE_PERCENT;
  const cleanHppMethod: 'moving_average' | 'fifo' =
    payload.hppMethod === 'fifo' ? 'fifo' : 'moving_average';
  const hasTarget = payload.dailySalesTarget !== undefined;
  const cleanTarget = hasTarget
    ? Math.max(0, Math.min(1000000000, Math.round(Number(payload.dailySalesTarget) || 0)))
    : undefined;

  try {
    await setDoc(
      ref,
      {
        storeName: payload.storeName.trim().slice(0, 100),
        ownerName: payload.ownerName.trim().slice(0, 100),
        ...(payload.address ? { address: payload.address.trim().slice(0, 240) } : {}),
        ...(payload.phone ? { phone: payload.phone.trim().slice(0, 24) } : {}),
        ...(payload.receiptHeader ? { receiptHeader: payload.receiptHeader.trim().slice(0, 200) } : {}),
        ...(payload.receiptThankYou ? { receiptThankYou: payload.receiptThankYou.trim().slice(0, 200) } : {}),
        ...(payload.receiptFooter ? { receiptFooter: payload.receiptFooter.trim().slice(0, 200) } : {}),
        qrisFeePercent: cleanQrisFee,
        hppMethod: cleanHppMethod,
        ...(cleanTarget !== undefined ? { dailySalesTarget: cleanTarget } : {}),
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'store_settings/main');
  }
}

export async function saveDailySalesTarget(
  targetAmount: number,
  currentSetting: StoreSetting | null,
  fallbackOwnerName: string,
  uid: string
): Promise<void> {
  const ref = doc(db, 'store_settings', 'main');
  const cleanTarget = Math.max(0, Math.min(1000000000, Math.round(Number(targetAmount) || 0)));

  try {
    if (currentSetting) {
      await updateDoc(ref, {
        dailySalesTarget: cleanTarget,
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
    } else {
      await setDoc(ref, {
        storeName: 'KEDAI KHANXA',
        ownerName: (fallbackOwnerName || 'Admin').trim().slice(0, 100),
        dailySalesTarget: cleanTarget,
        updatedByUid: uid,
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, 'store_settings/main');
  }
}

// 2. Akun Kas & Rekening
export function subscribeAccounts(
  onData: (accounts: Account[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'accounts'), orderBy('name', 'asc'));
  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: Account[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<Account, 'id'>),
      }));
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'accounts');
    }
  );
}

export async function createAccount(
  payload: {
    name: string;
    type: AccountType;
    accountNumber?: string;
    balance: number;
  },
  uid: string
): Promise<string> {
  const id = generateSafeId('acc');
  const ref = doc(db, 'accounts', id);
  try {
    await setDoc(ref, {
      name: payload.name.trim().slice(0, 80),
      type: payload.type,
      ...(payload.accountNumber?.trim()
        ? { accountNumber: payload.accountNumber.trim().slice(0, 40) }
        : {}),
      balance: Number(payload.balance) || 0,
      isActive: true,
      updatedByUid: uid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `accounts/${id}`);
  }
}

export async function updateAccount(
  id: string,
  payload: {
    name: string;
    type: AccountType;
    accountNumber?: string;
    balance: number;
    isActive: boolean;
  },
  uid: string
): Promise<void> {
  const ref = doc(db, 'accounts', id);
  try {
    await updateDoc(ref, {
      name: payload.name.trim().slice(0, 80),
      type: payload.type,
      accountNumber: (payload.accountNumber || '').trim().slice(0, 40),
      balance: Number(payload.balance) || 0,
      isActive: Boolean(payload.isActive),
      updatedByUid: uid,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `accounts/${id}`);
  }
}

export async function deleteAccount(id: string): Promise<void> {
  const ref = doc(db, 'accounts', id);
  try {
    await deleteDoc(ref);
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `accounts/${id}`);
  }
}

// 3. Pengguna & Hak Akses
export function subscribeUsers(
  onData: (users: UserProfile[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'users'), orderBy('displayName', 'asc'));
  return onSnapshot(
    q,
    (snap) => {
      onData(snap.docs.map((d) => d.data() as UserProfile));
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'users');
    }
  );
}

export async function updateUserAccess(
  targetUid: string,
  payload: {
    role: UserRole;
    status: UserStatus;
    shiftLabel?: string;
  }
): Promise<void> {
  const ref = doc(db, 'users', targetUid);
  try {
    await updateDoc(ref, {
      role: payload.role,
      status: payload.status,
      shiftLabel: (payload.shiftLabel || '').trim().slice(0, 40),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${targetUid}`);
  }
}

export function subscribeStaffInvites(
  onData: (invites: StaffInvite[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = query(collection(db, 'staff_invites'), orderBy('createdAt', 'desc'));
  return onSnapshot(
    q,
    (snap) => {
      const list: StaffInvite[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<StaffInvite, 'id'>),
      }));
      onData(list);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'staff_invites');
    }
  );
}

export async function createStaffInvite(
  payload: {
    email: string;
    displayName: string;
    role: 'admin' | 'kasir';
    shiftLabel?: string;
  },
  adminUid: string
): Promise<string> {
  const id = generateSafeId('inv');
  const ref = doc(db, 'staff_invites', id);
  try {
    await setDoc(ref, {
      email: payload.email.trim().toLowerCase().slice(0, 160),
      displayName: payload.displayName.trim().slice(0, 100),
      role: payload.role,
      ...(payload.shiftLabel?.trim()
        ? { shiftLabel: payload.shiftLabel.trim().slice(0, 40) }
        : {}),
      status: 'pending',
      invitedByUid: adminUid,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, `staff_invites/${id}`);
  }
}

export async function deleteStaffInvite(id: string): Promise<void> {
  try {
    await deleteDoc(doc(db, 'staff_invites', id));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, `staff_invites/${id}`);
  }
}

// 4. Metrik Real-time Hari Ini (hanya membaca dokumen hari ini, tanpa memuat seluruh riwayat)
export function subscribeTodayDashboardMetrics(
  todayDate: string,
  userUid: string,
  isAdmin: boolean,
  onChange: (metrics: TodayDashboardMetrics) => void
): Unsubscribe {
  const state: TodayDashboardMetrics = {
    retailSalesTotal: 0,
    retailProfitTotal: 0,
    retailQrisFeeTotal: 0,
    retailSalesCount: 0,
    miniAtmVolumeTotal: 0,
    miniAtmProfitTotal: 0,
    miniAtmCount: 0,
    ppobSalesTotal: 0,
    ppobProfitTotal: 0,
    ppobCount: 0,
    expensesTotal: 0,
    expensesCount: 0,
    lowStockCount: 0,
  };

  const emit = () => onChange({ ...state });

  const salesQ = isAdmin
    ? query(collection(db, 'sales'), where('transactionDate', '==', todayDate))
    : query(
        collection(db, 'sales'),
        where('transactionDate', '==', todayDate),
        where('recordedByUid', '==', userUid)
      );

  const atmQ = isAdmin
    ? query(collection(db, 'mini_atm_transactions'), where('transactionDate', '==', todayDate))
    : query(
        collection(db, 'mini_atm_transactions'),
        where('transactionDate', '==', todayDate),
        where('recordedByUid', '==', userUid)
      );

  const ppobQ = isAdmin
    ? query(collection(db, 'ppob_transactions'), where('transactionDate', '==', todayDate))
    : query(
        collection(db, 'ppob_transactions'),
        where('transactionDate', '==', todayDate),
        where('recordedByUid', '==', userUid)
      );

  const expQ = isAdmin
    ? query(collection(db, 'expenses'), where('transactionDate', '==', todayDate))
    : query(
        collection(db, 'expenses'),
        where('transactionDate', '==', todayDate),
        where('recordedByUid', '==', userUid)
      );

  const unsubs: Unsubscribe[] = [
    onSnapshot(
      salesQ,
      (snap) => {
        let total = 0;
        let profit = 0;
        let qrisFee = 0;
        let count = 0;
        snap.forEach((d) => {
          const data = d.data();
          if (data.status === 'completed') {
            total += Number(data.totalAmount || 0);
            profit += Number(data.totalProfit || 0);
            qrisFee += Number(data.qrisFeeAmount || 0);
            count += 1;
          }
        });
        state.retailSalesTotal = total;
        state.retailProfitTotal = profit;
        state.retailQrisFeeTotal = Number(qrisFee.toFixed(2));
        state.retailSalesCount = count;
        emit();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'sales')
    ),
    onSnapshot(
      atmQ,
      (snap) => {
        let volume = 0;
        let profit = 0;
        let count = 0;
        snap.forEach((d) => {
          const data = d.data();
          if (data.status === 'completed') {
            volume += Number(data.principalAmount || 0);
            profit += Number(data.netProfit || 0);
            count += 1;
          }
        });
        state.miniAtmVolumeTotal = volume;
        state.miniAtmProfitTotal = profit;
        state.miniAtmCount = count;
        emit();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'mini_atm_transactions')
    ),
    onSnapshot(
      ppobQ,
      (snap) => {
        let sales = 0;
        let profit = 0;
        let count = 0;
        snap.forEach((d) => {
          const data = d.data();
          if (data.status === 'completed') {
            sales += Number(data.sellPrice || 0);
            profit += Number(data.netProfit || 0);
            count += 1;
          }
        });
        state.ppobSalesTotal = sales;
        state.ppobProfitTotal = profit;
        state.ppobCount = count;
        emit();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'ppob_transactions')
    ),
    onSnapshot(
      expQ,
      (snap) => {
        let total = 0;
        snap.forEach((d) => {
          total += Number(d.data().amount || 0);
        });
        state.expensesTotal = total;
        state.expensesCount = snap.size;
        emit();
      },
      (err) => handleFirestoreError(err, OperationType.LIST, 'expenses')
    ),
  ];

  return () => {
    unsubs.forEach((u) => u());
  };
}

// 5. Mutasi Kas & Laporan Keuangan (Admin Only / Bounded Queries)
export function subscribeCashLedger(
  isAdmin: boolean,
  userUid: string,
  onData: (rows: CashLedger[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = isAdmin
    ? query(collection(db, 'cash_ledger'), orderBy('createdAt', 'desc'), limit(200))
    : query(collection(db, 'cash_ledger'), where('recordedByUid', '==', userUid), limit(100));

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: CashLedger[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<CashLedger, 'id'>),
      }));
      list.sort((a, b) => {
        const keyA = `${a.transactionDate} ${a.transactionTime}`;
        const keyB = `${b.transactionDate} ${b.transactionTime}`;
        return keyB.localeCompare(keyA);
      });
      onData(list);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'cash_ledger');
    }
  );
}

export function subscribeReportCollections(
  onData: (data: {
    sales: Sale[];
    expenses: Expense[];
    miniAtms: MiniAtmTransaction[];
    ppobs: PpobTransaction[];
  }) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const state = {
    sales: [] as Sale[],
    expenses: [] as Expense[],
    miniAtms: [] as MiniAtmTransaction[],
    ppobs: [] as PpobTransaction[],
  };

  const emit = () =>
    onData({
      sales: state.sales,
      expenses: state.expenses,
      miniAtms: state.miniAtms,
      ppobs: state.ppobs,
    });

  const unsubs: Unsubscribe[] = [
    onSnapshot(
      query(collection(db, 'sales'), orderBy('transactionDate', 'desc'), limit(500)),
      (snap) => {
        state.sales = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Sale, 'id'>),
        }));
        state.sales.sort((a, b) =>
          `${b.transactionDate} ${b.transactionTime}`.localeCompare(
            `${a.transactionDate} ${a.transactionTime}`
          )
        );
        emit();
      },
      (err) => {
        onError(err);
        handleFirestoreError(err, OperationType.LIST, 'sales');
      }
    ),
    onSnapshot(
      query(collection(db, 'expenses'), orderBy('transactionDate', 'desc'), limit(300)),
      (snap) => {
        state.expenses = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<Expense, 'id'>),
        }));
        emit();
      },
      (err) => {
        onError(err);
        handleFirestoreError(err, OperationType.LIST, 'expenses');
      }
    ),
    onSnapshot(
      query(collection(db, 'mini_atm_transactions'), orderBy('transactionDate', 'desc'), limit(300)),
      (snap) => {
        state.miniAtms = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<MiniAtmTransaction, 'id'>),
        }));
        emit();
      },
      (err) => {
        onError(err);
        handleFirestoreError(err, OperationType.LIST, 'mini_atm_transactions');
      }
    ),
    onSnapshot(
      query(collection(db, 'ppob_transactions'), orderBy('transactionDate', 'desc'), limit(300)),
      (snap) => {
        state.ppobs = snap.docs.map((d) => ({
          id: d.id,
          ...(d.data() as Omit<PpobTransaction, 'id'>),
        }));
        emit();
      },
      (err) => {
        onError(err);
        handleFirestoreError(err, OperationType.LIST, 'ppob_transactions');
      }
    ),
  ];

  return () => {
    unsubs.forEach((u) => u());
  };
}
