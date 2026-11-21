import {
  collection,
  doc,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from '../firebase';
import type {
  Account,
  Customer,
  MiniAtmFeeAudit,
  MiniAtmPaymentChannel,
  MiniAtmSetting,
  MiniAtmTransaction,
  PpobTransaction,
  ServicePaymentStatus,
} from '../types/database';
import { handleFirestoreError, OperationType } from '../utils/firestoreError';
import { createTransactionMetadata, formatRupiah, generateSafeId } from '../utils/formatters';
import { roundMoney } from '../utils/unitConversion';
import {
  calculateMiniAtmBreakdown,
  calculatePpobBreakdown,
  getMiniAtmServiceLabel,
  getPpobCategoryLabel,
  normalizeMiniAtmSettings,
  type MiniAtmServiceType,
  type MiniAtmSettingValues,
  type PpobCategory,
} from '../utils/serviceTransactions';

function isOfflineTransactionError(error: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const code = (error as { code?: string })?.code || '';
  return code === 'unavailable' || code === 'failed-precondition';
}

// ---------------------------------------------------------------------------
// 1. MINI ATM MODULE
// ---------------------------------------------------------------------------

const MINI_ATM_SETTINGS_DOC_ID = 'main';

export function subscribeMiniAtmSettings(
  onData: (settings: MiniAtmSettingValues, rawDoc: MiniAtmSetting | null) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const ref = doc(db, 'mini_atm_settings', MINI_ATM_SETTINGS_DOC_ID);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onData(normalizeMiniAtmSettings(null), null);
        return;
      }
      const raw = { id: snap.id, ...(snap.data() as Omit<MiniAtmSetting, 'id'>) };
      onData(normalizeMiniAtmSettings(raw), raw);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.GET, `mini_atm_settings/${MINI_ATM_SETTINGS_DOC_ID}`);
    }
  );
}

export async function saveMiniAtmSettings(
  values: MiniAtmSettingValues,
  user: { uid: string; displayName: string }
): Promise<void> {
  const clean = normalizeMiniAtmSettings(values);
  const sanitizedTiers = clean.feeTiers.slice(0, 30).map((t, idx) => ({
    id: (t.id || `tier-${idx + 1}`).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
    serviceScope: t.serviceScope,
    minAmount: Math.max(0, roundMoney(t.minAmount)),
    maxAmount: Math.max(0, roundMoney(t.maxAmount)),
    adminFee: Math.max(0, roundMoney(t.adminFee)),
    ...(typeof t.bankFee === 'number' && Number.isFinite(t.bankFee)
      ? { bankFee: Math.max(0, roundMoney(t.bankFee)) }
      : {}),
  }));

  const sanitizedBankRules = clean.bankFeeRules
    .filter((r) => r.bankName.trim().length > 0)
    .slice(0, 40)
    .map((r) => ({
      bankName: r.bankName.trim().slice(0, 60),
      defaultBankFee: Math.max(0, roundMoney(r.defaultBankFee)),
    }));

  const ref = doc(db, 'mini_atm_settings', MINI_ATM_SETTINGS_DOC_ID);
  try {
    await setDoc(ref, {
      allowQrisTarikTunai: clean.allowQrisTarikTunai,
      qrisProviderNote: (clean.qrisProviderNote || '').trim().slice(0, 200),
      qrisMdrPercent: clean.qrisMdrPercent,
      qrisInternalExtraThreshold: clean.qrisInternalExtraThreshold,
      qrisInternalExtraFee: clean.qrisInternalExtraFee,
      defaultTarikTunaiFee: clean.defaultTarikTunaiFee,
      defaultTransferFee: clean.defaultTransferFee,
      feeTiers: sanitizedTiers,
      bankFeeRules: sanitizedBankRules,
      updatedByUid: user.uid,
      updatedByName: (user.displayName || 'Admin').slice(0, 100),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `mini_atm_settings/${MINI_ATM_SETTINGS_DOC_ID}`);
  }
}

export function subscribeMiniAtmFeeAudits(
  isAdmin: boolean,
  userUid: string,
  onData: (rows: MiniAtmFeeAudit[]) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = isAdmin
    ? query(collection(db, 'mini_atm_fee_audits'), orderBy('createdAt', 'desc'), limit(150))
    : query(
        collection(db, 'mini_atm_fee_audits'),
        where('recordedByUid', '==', userUid),
        limit(100)
      );

  return onSnapshot(
    q,
    (snap) => {
      const list: MiniAtmFeeAudit[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<MiniAtmFeeAudit, 'id'>),
      }));
      list.sort((a, b) =>
        `${b.transactionDate} ${b.transactionTime}`.localeCompare(
          `${a.transactionDate} ${a.transactionTime}`
        )
      );
      onData(list);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'mini_atm_fee_audits');
    }
  );
}

export function subscribeMiniAtmTransactions(
  isAdmin: boolean,
  userUid: string,
  onData: (rows: MiniAtmTransaction[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = isAdmin
    ? query(collection(db, 'mini_atm_transactions'), orderBy('createdAt', 'desc'), limit(300))
    : query(
        collection(db, 'mini_atm_transactions'),
        where('recordedByUid', '==', userUid),
        limit(200)
      );

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: MiniAtmTransaction[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<MiniAtmTransaction, 'id'>),
      }));
      list.sort((a, b) =>
        `${b.transactionDate} ${b.transactionTime}`.localeCompare(
          `${a.transactionDate} ${a.transactionTime}`
        )
      );
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'mini_atm_transactions');
    }
  );
}

export interface RecordMiniAtmInput {
  serviceType: MiniAtmServiceType;
  paymentChannel?: MiniAtmPaymentChannel;
  paymentStatus?: ServicePaymentStatus;
  paidAmount?: number;
  allowQrisTarikTunai?: boolean;
  qrisVerified?: boolean;
  transferVerified?: boolean;
  qrisMdrRate?: number;
  qrisInternalExtraThreshold?: number;
  qrisInternalExtraFee?: number;
  bankName: string;
  targetAccountNumber?: string;
  customer?: Customer | null;
  customerName?: string;
  autoCreateCustomer?: boolean;
  newCustomerPhone?: string;
  externalReferenceNumber?: string;
  transferProofDataUrl?: string;
  principalAmount: number;
  adminFee: number;
  bankFee: number;
  standardAdminFee?: number;
  standardBankFee?: number;
  feeOverrideReason?: string;
  cashAccount: Account;
  bankAccount: Account;
  notes?: string;
}

export async function recordMiniAtmTransaction(
  input: RecordMiniAtmInput,
  user: { uid: string; displayName: string }
): Promise<{
  txId: string;
  transactionNumber: string;
  netProfit: number;
  paymentStatus: ServicePaymentStatus;
  paidAmount: number;
  debtAmount: number;
  customerId?: string;
  customerName?: string;
  customerDebtAfter?: number;
}> {
  if (input.serviceType === 'setor_tunai') {
    throw new Error('Menu Setor Tunai dinonaktifkan. Gunakan layanan Tarik Tunai atau Transfer Bank.');
  }

  const cleanBank = input.bankName.trim().slice(0, 60);
  if (!cleanBank) {
    throw new Error('Nama bank / tujuan wajib diisi.');
  }
  const cleanTarget = (input.targetAccountNumber || '').trim().slice(0, 40);
  const cleanTypedCustomer = (input.customerName || '').trim().slice(0, 100);
  const willAutoCreateCustomer = Boolean(
    input.autoCreateCustomer &&
      !input.customer &&
      cleanTypedCustomer &&
      cleanTypedCustomer.toLowerCase() !== 'umum'
  );
  const cleanNewCustomerPhone = (input.newCustomerPhone || '').trim().slice(0, 24);
  const effectiveCustomerName = (input.customer?.name || cleanTypedCustomer).slice(0, 100);
  const paymentStatus: ServicePaymentStatus = input.paymentStatus === 'debt' ? 'debt' : 'paid';

  const cleanExternalRef = (input.externalReferenceNumber || '').trim().slice(0, 80);
  const cleanProof = (input.transferProofDataUrl || '').trim();
  if (cleanProof.length > 80000) {
    throw new Error('Ukuran file bukti transfer terlalu besar setelah kompresi.');
  }

  if (input.serviceType === 'transfer') {
    if (!cleanTarget) {
      throw new Error('Nomor rekening tujuan wajib diisi untuk layanan Transfer Bank.');
    }
    if (!effectiveCustomerName) {
      throw new Error('Nama penerima wajib diisi untuk layanan Transfer Bank.');
    }
    if (!input.transferVerified) {
      throw new Error(
        'Transfer Bank hanya dapat diselesaikan setelah transfer ke rekening tujuan berhasil diverifikasi.'
      );
    }
  }

  if (paymentStatus === 'debt' && !input.customer && !willAutoCreateCustomer) {
    throw new Error(
      'Pilih atau ketik nama pelanggan terlebih dahulu untuk transaksi Mini ATM berstatus Hutang (Bon).'
    );
  }

  if (!input.cashAccount.isActive) {
    throw new Error(`Akun kas "${input.cashAccount.name}" sedang nonaktif.`);
  }
  if (!input.bankAccount.isActive) {
    throw new Error(`Akun rekening "${input.bankAccount.name}" sedang nonaktif.`);
  }
  if (input.cashAccount.id === input.bankAccount.id) {
    throw new Error('Akun Laci Kas dan Akun Rekening Bank tidak boleh sama.');
  }

  const breakdown = calculateMiniAtmBreakdown({
    serviceType: input.serviceType,
    paymentChannel: input.paymentChannel,
    paymentStatus,
    paidAmount: input.paidAmount,
    allowQrisTarikTunai: input.allowQrisTarikTunai,
    qrisVerified: input.qrisVerified,
    qrisMdrRate: input.qrisMdrRate,
    qrisInternalExtraThreshold: input.qrisInternalExtraThreshold,
    qrisInternalExtraFee: input.qrisInternalExtraFee,
    principalAmount: input.principalAmount,
    adminFee: input.adminFee,
    bankFee: input.bankFee,
  });

  const standardAdminFee = roundMoney(
    typeof input.standardAdminFee === 'number' && Number.isFinite(input.standardAdminFee)
      ? Math.max(0, input.standardAdminFee)
      : breakdown.adminFee
  );
  const standardBankFee = roundMoney(
    typeof input.standardBankFee === 'number' && Number.isFinite(input.standardBankFee)
      ? Math.max(0, input.standardBankFee)
      : breakdown.bankFee
  );
  const feeOverridden =
    Math.abs(breakdown.adminFee - standardAdminFee) > 0.009 ||
    Math.abs(breakdown.bankFee - standardBankFee) > 0.009;
  const cleanOverrideReason = (input.feeOverrideReason || '').trim().slice(0, 200);

  const txId = generateSafeId('atm');
  const cashLedgerId = generateSafeId('ldg');
  const bankLedgerId = generateSafeId('ldg');
  const auditId = generateSafeId('aud');
  const resolvedCustomerId =
    input.customer?.id || (willAutoCreateCustomer ? generateSafeId('cst') : undefined);
  const meta = createTransactionMetadata('ATM', user);
  const serviceLabel = getMiniAtmServiceLabel(input.serviceType);
  const cleanNotes = (input.notes || '').trim().slice(0, 240);

  const txRef = doc(db, 'mini_atm_transactions', txId);
  const cashAccRef = doc(db, 'accounts', input.cashAccount.id);
  const bankAccRef = doc(db, 'accounts', input.bankAccount.id);
  const cashLedgerRef = doc(db, 'cash_ledger', cashLedgerId);
  const bankLedgerRef = doc(db, 'cash_ledger', bankLedgerId);
  const auditRef = doc(db, 'mini_atm_fee_audits', auditId);
  const customerRef = input.customer ? doc(db, 'customers', input.customer.id) : null;

  let finalCustomerDebtAfter: number | undefined;

  const applyAccountAndLedgerWrites = (
    cashAccData: Pick<Account, 'name' | 'balance'>,
    bankAccData: Pick<Account, 'name' | 'balance'>,
    liveCustomerData: Pick<Customer, 'totalDebt'> | null,
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    }
  ) => {
    const cashBefore = roundMoney(Number(cashAccData.balance) || 0);
    const cashAfter = roundMoney(cashBefore + breakdown.cashDelta);
    if (cashAfter < 0) {
      throw new Error(
        `Saldo ${cashAccData.name} (${formatRupiah(cashBefore)}) tidak mencukupi untuk ${serviceLabel} ${formatRupiah(
          breakdown.principalAmount
        )}.`
      );
    }

    const bankBefore = roundMoney(Number(bankAccData.balance) || 0);
    const bankAfter = roundMoney(bankBefore + breakdown.bankDelta);
    if (bankAfter < 0) {
      throw new Error(
        `Saldo ${bankAccData.name} (${formatRupiah(bankBefore)}) tidak mencukupi untuk ${serviceLabel} ${formatRupiah(
          breakdown.principalAmount + breakdown.bankFee
        )}.`
      );
    }

    if (breakdown.cashDelta !== 0) {
      writer.update(cashAccRef, {
        balance: cashAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }
    if (breakdown.bankDelta !== 0) {
      writer.update(bankAccRef, {
        balance: bankAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }

    if (willAutoCreateCustomer && resolvedCustomerId) {
      finalCustomerDebtAfter = breakdown.debtAmount;
      writer.set(doc(db, 'customers', resolvedCustomerId), {
        name: effectiveCustomerName,
        ...(cleanNewCustomerPhone ? { phone: cleanNewCustomerPhone } : {}),
        totalDebt: breakdown.debtAmount,
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (input.customer && breakdown.debtAmount > 0) {
      const prevDebt = roundMoney(Math.max(0, Number(liveCustomerData?.totalDebt) || 0));
      finalCustomerDebtAfter = roundMoney(prevDebt + breakdown.debtAmount);
      writer.update(doc(db, 'customers', input.customer.id), {
        totalDebt: finalCustomerDebtAfter,
        updatedAt: serverTimestamp(),
      });
    } else if (input.customer) {
      finalCustomerDebtAfter = roundMoney(Math.max(0, Number(liveCustomerData?.totalDebt) || 0));
    }

    if (breakdown.debtAmount > 0 && resolvedCustomerId) {
      const recId = generateSafeId('rec');
      const recMeta = createTransactionMetadata('KBN', user);
      const debtBalanceAfter = finalCustomerDebtAfter ?? breakdown.debtAmount;
      writer.set(doc(db, 'receivables', recId), {
        ...recMeta,
        customerId: resolvedCustomerId,
        customerName: effectiveCustomerName,
        type: 'debt',
        amount: breakdown.debtAmount,
        balanceAfter: debtBalanceAfter,
        sourceType: 'mini_atm',
        referenceId: txId,
        ...(breakdown.paidAmount > 0 ? { accountId: input.cashAccount.id } : {}),
        notes: (
          breakdown.paidAmount > 0
            ? `Bon Mini ATM ${serviceLabel} ${meta.transactionNumber} (Tagihan ${formatRupiah(
                breakdown.totalDue
              )}, DP ${formatRupiah(breakdown.paidAmount)})`
            : `Bon Mini ATM ${serviceLabel} ${cleanBank} (${meta.transactionNumber})`
        ).slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }

    writer.set(txRef, {
      ...meta,
      serviceType: input.serviceType,
      paymentChannel: breakdown.paymentChannel,
      paymentStatus: breakdown.paymentStatus,
      bankName: cleanBank,
      ...(cleanTarget ? { targetAccountNumber: cleanTarget } : {}),
      ...(resolvedCustomerId ? { customerId: resolvedCustomerId } : {}),
      ...(effectiveCustomerName ? { customerName: effectiveCustomerName } : {}),
      principalAmount: breakdown.principalAmount,
      adminFee: breakdown.adminFee,
      bankFee: breakdown.bankFee,
      paidAmount: breakdown.paidAmount,
      debtAmount: breakdown.debtAmount,
      ...(breakdown.paymentChannel === 'qris'
        ? {
            qrisVerified: true,
            qrisMdrRate: breakdown.qrisMdrRate,
            qrisMdrAmount: breakdown.qrisMdrAmount,
            internalExtraFee: breakdown.internalExtraFee,
          }
        : {}),
      ...(input.serviceType === 'transfer' ? { transferVerified: true } : {}),
      ...(cleanExternalRef ? { externalReferenceNumber: cleanExternalRef } : {}),
      ...(cleanProof ? { transferProofDataUrl: cleanProof } : {}),
      standardAdminFee,
      standardBankFee,
      feeOverridden,
      ...(cleanOverrideReason ? { feeOverrideReason: cleanOverrideReason } : {}),
      netProfit: breakdown.netProfit,
      cashAccountId: input.cashAccount.id,
      bankAccountId: input.bankAccount.id,
      ...(cleanNotes ? { notes: cleanNotes } : {}),
      status: 'completed',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (feeOverridden) {
      writer.set(auditRef, {
        ...meta,
        miniAtmTxId: txId,
        serviceType: input.serviceType,
        bankName: cleanBank,
        principalAmount: breakdown.principalAmount,
        standardAdminFee,
        appliedAdminFee: breakdown.adminFee,
        standardBankFee,
        appliedBankFee: breakdown.bankFee,
        ...(cleanOverrideReason ? { reason: cleanOverrideReason } : {}),
        createdAt: serverTimestamp(),
      });
    }

    if (breakdown.cashLedgerAmount > 0) {
      writer.set(cashLedgerRef, {
        ...meta,
        transactionNumber: `${meta.transactionNumber}-K`.slice(0, 40),
        accountId: input.cashAccount.id,
        accountName: cashAccData.name.slice(0, 80),
        direction: breakdown.cashDirection,
        amount: breakdown.cashLedgerAmount,
        balanceBefore: cashBefore,
        balanceAfter: cashAfter,
        sourceModule: 'mini_atm',
        referenceId: txId,
        description: `Mini ATM ${serviceLabel}${
          breakdown.paymentChannel === 'qris' ? ' (QRIS)' : ''
        }${breakdown.paymentStatus === 'debt' ? ' [DP Bon]' : ''} ${cleanBank}${
          effectiveCustomerName ? ` (${effectiveCustomerName})` : ''
        }`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }

    if (breakdown.bankLedgerAmount > 0) {
      writer.set(bankLedgerRef, {
        ...meta,
        transactionNumber: `${meta.transactionNumber}-B`.slice(0, 40),
        accountId: input.bankAccount.id,
        accountName: bankAccData.name.slice(0, 80),
        direction: breakdown.bankDirection,
        amount: breakdown.bankLedgerAmount,
        balanceBefore: bankBefore,
        balanceAfter: bankAfter,
        sourceModule: 'mini_atm',
        referenceId: txId,
        description: `Mini ATM ${serviceLabel}${
          breakdown.paymentChannel === 'qris'
            ? ` QRIS (MDR ${formatRupiah(breakdown.qrisMdrAmount)})`
            : ''
        } ${cleanBank}${cleanTarget ? ` · ${cleanTarget}` : ''}`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }
  };

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    applyAccountAndLedgerWrites(input.cashAccount, input.bankAccount, input.customer || null, {
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
          const [cashSnap, bankSnap, custSnap] = await Promise.all([
            tx.get(cashAccRef),
            tx.get(bankAccRef),
            customerRef ? tx.get(customerRef) : Promise.resolve(null),
          ]);
          if (!cashSnap.exists()) {
            throw new Error('Akun Laci Kas tidak ditemukan.');
          }
          if (!bankSnap.exists()) {
            throw new Error('Akun Rekening Bank tidak ditemukan.');
          }
          const liveCustomerData =
            custSnap && custSnap.exists() ? (custSnap.data() as Customer) : input.customer || null;
          applyAccountAndLedgerWrites(
            cashSnap.data() as Account,
            bankSnap.data() as Account,
            liveCustomerData,
            {
              set: (ref, data) => tx.set(ref, data),
              update: (ref, data) => tx.update(ref, data),
            }
          );
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
      txId,
      transactionNumber: meta.transactionNumber,
      netProfit: breakdown.netProfit,
      paymentStatus: breakdown.paymentStatus,
      paidAmount: breakdown.paidAmount,
      debtAmount: breakdown.debtAmount,
      customerId: resolvedCustomerId,
      customerName: effectiveCustomerName || undefined,
      customerDebtAfter: breakdown.debtAmount > 0 ? finalCustomerDebtAfter : undefined,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `mini_atm_transactions/${txId}`);
  }
}

export async function voidMiniAtmTransaction(
  txDoc: MiniAtmTransaction,
  accounts: Account[],
  user: { uid: string; displayName: string },
  customers: Customer[] = []
): Promise<void> {
  if (txDoc.status === 'void') {
    throw new Error('Transaksi Mini ATM ini sudah dibatalkan (void).');
  }
  if (txDoc.cashAccountId === txDoc.bankAccountId) {
    throw new Error('Data akun kas dan bank tidak valid untuk pembatalan.');
  }

  const breakdown = calculateMiniAtmBreakdown({
    serviceType: txDoc.serviceType,
    paymentChannel: txDoc.paymentChannel || 'bank_transfer',
    paymentStatus: txDoc.paymentStatus || 'paid',
    paidAmount: txDoc.paidAmount,
    allowQrisTarikTunai: true,
    qrisVerified: true,
    qrisMdrRate: txDoc.qrisMdrRate,
    qrisMdrAmountOverride: txDoc.qrisMdrAmount,
    qrisInternalExtraFeeOverride: txDoc.internalExtraFee,
    principalAmount: txDoc.principalAmount,
    adminFee: txDoc.adminFee,
    bankFee: txDoc.bankFee,
  });

  const revCashDelta = roundMoney(-breakdown.cashDelta);
  const revBankDelta = roundMoney(-breakdown.bankDelta);
  const originalDebt = roundMoney(Math.max(0, Number(txDoc.debtAmount) || 0));

  const meta = createTransactionMetadata('VATM', user);
  const txRef = doc(db, 'mini_atm_transactions', txDoc.id);
  const cashAccRef = doc(db, 'accounts', txDoc.cashAccountId);
  const bankAccRef = doc(db, 'accounts', txDoc.bankAccountId);
  const custRef =
    originalDebt > 0 && txDoc.customerId ? doc(db, 'customers', txDoc.customerId) : null;
  const cashLedgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));
  const bankLedgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));

  const applyVoidWrites = (
    cashAccData: Pick<Account, 'name' | 'balance'>,
    bankAccData: Pick<Account, 'name' | 'balance'>,
    custData: Pick<Customer, 'name' | 'totalDebt'> | null,
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    }
  ) => {
    const cashBefore = roundMoney(Number(cashAccData.balance) || 0);
    const cashAfter = roundMoney(cashBefore + revCashDelta);
    const bankBefore = roundMoney(Number(bankAccData.balance) || 0);
    const bankAfter = roundMoney(bankBefore + revBankDelta);

    if (cashAfter < 0) {
      throw new Error(
        `Saldo ${cashAccData.name} (${formatRupiah(cashBefore)}) tidak mencukupi untuk membalik transaksi ini.`
      );
    }
    if (bankAfter < 0) {
      throw new Error(
        `Saldo ${bankAccData.name} (${formatRupiah(bankBefore)}) tidak mencukupi untuk membalik transaksi ini.`
      );
    }

    writer.update(txRef, {
      status: 'void',
      updatedAt: serverTimestamp(),
    });
    if (revCashDelta !== 0) {
      writer.update(cashAccRef, {
        balance: cashAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }
    if (revBankDelta !== 0) {
      writer.update(bankAccRef, {
        balance: bankAfter,
        updatedByUid: user.uid,
        updatedAt: serverTimestamp(),
      });
    }

    if (custRef && custData && originalDebt > 0) {
      const liveDebt = roundMoney(Math.max(0, Number(custData.totalDebt) || 0));
      const debtToReduce = roundMoney(Math.min(liveDebt, originalDebt));
      if (debtToReduce > 0) {
        const balanceAfter = roundMoney(Math.max(0, liveDebt - debtToReduce));
        writer.update(custRef, {
          totalDebt: balanceAfter,
          updatedAt: serverTimestamp(),
        });
        const recMeta = createTransactionMetadata('KRV', user);
        writer.set(doc(db, 'receivables', generateSafeId('rec')), {
          ...recMeta,
          customerId: txDoc.customerId!,
          customerName: (custData.name || txDoc.customerName || 'Pelanggan').slice(0, 100),
          type: 'payment',
          amount: debtToReduce,
          balanceAfter,
          sourceType: 'mini_atm',
          referenceId: txDoc.id,
          notes: `Pembatalan (Void) Bon Mini ATM ${txDoc.transactionNumber}`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }
    }

    if (Math.abs(revCashDelta) > 0) {
      writer.set(cashLedgerRef, {
        ...meta,
        transactionNumber: `${meta.transactionNumber}-K`.slice(0, 40),
        accountId: txDoc.cashAccountId,
        accountName: cashAccData.name.slice(0, 80),
        direction: revCashDelta >= 0 ? 'in' : 'out',
        amount: roundMoney(Math.abs(revCashDelta)),
        balanceBefore: cashBefore,
        balanceAfter: cashAfter,
        sourceModule: 'mini_atm',
        referenceId: txDoc.id,
        description: `Pembatalan (Void) Mini ATM ${txDoc.transactionNumber}`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }

    if (Math.abs(revBankDelta) > 0) {
      writer.set(bankLedgerRef, {
        ...meta,
        transactionNumber: `${meta.transactionNumber}-B`.slice(0, 40),
        accountId: txDoc.bankAccountId,
        accountName: bankAccData.name.slice(0, 80),
        direction: revBankDelta >= 0 ? 'in' : 'out',
        amount: roundMoney(Math.abs(revBankDelta)),
        balanceBefore: bankBefore,
        balanceAfter: bankAfter,
        sourceModule: 'mini_atm',
        referenceId: txDoc.id,
        description: `Pembatalan (Void) Mini ATM ${txDoc.transactionNumber}`.slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }
  };

  const executeOfflineBatch = async () => {
    const cashAcc = accounts.find((a) => a.id === txDoc.cashAccountId);
    const bankAcc = accounts.find((a) => a.id === txDoc.bankAccountId);
    if (!cashAcc || !bankAcc) {
      throw new Error('Akun kas atau rekening terkait tidak ditemukan.');
    }
    const cust = txDoc.customerId ? customers.find((c) => c.id === txDoc.customerId) || null : null;
    const batch = writeBatch(db);
    applyVoidWrites(cashAcc, bankAcc, cust, {
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
          const [txSnap, cashSnap, bankSnap, custSnap] = await Promise.all([
            tx.get(txRef),
            tx.get(cashAccRef),
            tx.get(bankAccRef),
            custRef ? tx.get(custRef) : Promise.resolve(null),
          ]);
          if (!txSnap.exists()) {
            throw new Error('Transaksi Mini ATM tidak ditemukan.');
          }
          if ((txSnap.data() as MiniAtmTransaction).status === 'void') {
            throw new Error('Transaksi Mini ATM ini sudah dibatalkan.');
          }
          if (!cashSnap.exists() || !bankSnap.exists()) {
            throw new Error('Akun kas atau rekening terkait tidak ditemukan.');
          }
          const custData = custSnap && custSnap.exists() ? (custSnap.data() as Customer) : null;
          applyVoidWrites(cashSnap.data() as Account, bankSnap.data() as Account, custData, {
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
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.UPDATE, `mini_atm_transactions/${txDoc.id}`);
  }
}

// ---------------------------------------------------------------------------
// 2. PPOB MODULE
// ---------------------------------------------------------------------------

export function subscribePpobTransactions(
  isAdmin: boolean,
  userUid: string,
  onData: (rows: PpobTransaction[], hasPendingWrites: boolean) => void,
  onError: (err: unknown) => void
): Unsubscribe {
  const q = isAdmin
    ? query(collection(db, 'ppob_transactions'), orderBy('createdAt', 'desc'), limit(250))
    : query(
        collection(db, 'ppob_transactions'),
        where('recordedByUid', '==', userUid),
        limit(200)
      );

  return onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snap) => {
      const list: PpobTransaction[] = snap.docs.map((d) => ({
        id: d.id,
        ...(d.data() as Omit<PpobTransaction, 'id'>),
      }));
      list.sort((a, b) =>
        `${b.transactionDate} ${b.transactionTime}`.localeCompare(
          `${a.transactionDate} ${a.transactionTime}`
        )
      );
      onData(list, snap.metadata.hasPendingWrites);
    },
    (error) => {
      onError(error);
      handleFirestoreError(error, OperationType.LIST, 'ppob_transactions');
    }
  );
}

export interface RecordPpobInput {
  category: PpobCategory;
  providerName: string;
  targetNumber: string;
  customer?: Customer | null;
  customerName?: string;
  autoCreateCustomer?: boolean;
  newCustomerPhone?: string;
  paymentStatus?: ServicePaymentStatus;
  paidAmount?: number;
  capitalPrice: number;
  sellPrice: number;
  adminFee: number;
  depositAccount: Account;
  cashAccount: Account;
  serialNumber?: string;
  status: 'completed' | 'pending';
}

export async function recordPpobTransaction(
  input: RecordPpobInput,
  user: { uid: string; displayName: string }
): Promise<{
  txId: string;
  transactionNumber: string;
  netProfit: number;
  customerTotal: number;
  paymentStatus: ServicePaymentStatus;
  paidAmount: number;
  debtAmount: number;
  customerId?: string;
  customerName?: string;
  customerDebtAfter?: number;
}> {
  const cleanProvider = input.providerName.trim().slice(0, 80);
  const cleanTarget = input.targetNumber.trim().slice(0, 50);
  if (!cleanProvider) {
    throw new Error('Nama provider / produk PPOB wajib diisi.');
  }
  if (cleanTarget.length < 3) {
    throw new Error('Nomor tujuan / ID pelanggan minimal 3 karakter.');
  }
  if (!input.depositAccount.isActive) {
    throw new Error(`Akun modal/deposit "${input.depositAccount.name}" sedang nonaktif.`);
  }
  if (!input.cashAccount.isActive) {
    throw new Error(`Akun penerima bayar "${input.cashAccount.name}" sedang nonaktif.`);
  }

  const paymentStatus: ServicePaymentStatus = input.paymentStatus === 'debt' ? 'debt' : 'paid';
  const cleanTypedCustomer = (input.customerName || '').trim().slice(0, 100);
  const willAutoCreateCustomer = Boolean(
    input.autoCreateCustomer &&
      !input.customer &&
      cleanTypedCustomer &&
      cleanTypedCustomer.toLowerCase() !== 'umum'
  );
  const cleanNewCustomerPhone = (input.newCustomerPhone || '').trim().slice(0, 24);
  const effectiveCustomerName = (input.customer?.name || cleanTypedCustomer).slice(0, 100);

  if (paymentStatus === 'debt' && !input.customer && !willAutoCreateCustomer) {
    throw new Error(
      'Pilih atau ketik nama pelanggan terlebih dahulu untuk transaksi PPOB berstatus Hutang (Bon).'
    );
  }

  const breakdown = calculatePpobBreakdown({
    capitalPrice: input.capitalPrice,
    sellPrice: input.sellPrice,
    adminFee: input.adminFee,
    paymentStatus,
    paidAmount: input.paidAmount,
  });

  const txId = generateSafeId('ppb');
  const resolvedCustomerId =
    input.customer?.id || (willAutoCreateCustomer ? generateSafeId('cst') : undefined);
  const meta = createTransactionMetadata('PPB', user);
  const categoryLabel = getPpobCategoryLabel(input.category);
  const cleanSn = (input.serialNumber || '').trim().slice(0, 100);

  const sameAccount = input.depositAccount.id === input.cashAccount.id;
  const txRef = doc(db, 'ppob_transactions', txId);
  const depAccRef = doc(db, 'accounts', input.depositAccount.id);
  const cashAccRef = doc(db, 'accounts', input.cashAccount.id);
  const customerRef = input.customer ? doc(db, 'customers', input.customer.id) : null;
  const depLedgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));
  const cashLedgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));

  let finalCustomerDebtAfter: number | undefined;

  const applyWrites = (
    depAccData: Pick<Account, 'name' | 'balance'>,
    cashAccData: Pick<Account, 'name' | 'balance'>,
    liveCustomerData: Pick<Customer, 'totalDebt'> | null,
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    }
  ) => {
    const depBefore = roundMoney(Number(depAccData.balance) || 0);
    if (depBefore < breakdown.capitalPrice) {
      throw new Error(
        `Saldo ${depAccData.name} (${formatRupiah(depBefore)}) tidak mencukupi untuk modal ${formatRupiah(
          breakdown.capitalPrice
        )}.`
      );
    }

    if (sameAccount) {
      const mergedAfter = roundMoney(
        depBefore - breakdown.capitalPrice + breakdown.cashReceiptDelta
      );
      if (mergedAfter < 0) {
        throw new Error(`Saldo ${depAccData.name} tidak boleh negatif.`);
      }
      if (breakdown.capitalPrice > 0 || breakdown.cashReceiptDelta > 0) {
        writer.update(depAccRef, {
          balance: mergedAfter,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
      }

      if (breakdown.capitalPrice > 0) {
        const afterModal = roundMoney(depBefore - breakdown.capitalPrice);
        writer.set(depLedgerRef, {
          ...meta,
          transactionNumber: `${meta.transactionNumber}-M`.slice(0, 40),
          accountId: input.depositAccount.id,
          accountName: depAccData.name.slice(0, 80),
          direction: 'out',
          amount: breakdown.capitalPrice,
          balanceBefore: depBefore,
          balanceAfter: afterModal,
          sourceModule: 'ppob',
          referenceId: txId,
          description: `Modal PPOB ${categoryLabel} ${cleanProvider} (${cleanTarget})`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }

      if (breakdown.cashReceiptDelta > 0) {
        const beforeReceipt = roundMoney(depBefore - breakdown.capitalPrice);
        writer.set(cashLedgerRef, {
          ...meta,
          transactionNumber: `${meta.transactionNumber}-J`.slice(0, 40),
          accountId: input.depositAccount.id,
          accountName: depAccData.name.slice(0, 80),
          direction: 'in',
          amount: breakdown.cashReceiptDelta,
          balanceBefore: beforeReceipt,
          balanceAfter: mergedAfter,
          sourceModule: 'ppob',
          referenceId: txId,
          description: `${
            breakdown.paymentStatus === 'debt' ? 'DP Bon PPOB' : 'Bayar PPOB'
          } ${categoryLabel} ${cleanProvider} (${cleanTarget})`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }
    } else {
      const depAfter = roundMoney(depBefore - breakdown.capitalPrice);
      const cashBefore = roundMoney(Number(cashAccData.balance) || 0);
      const cashAfter = roundMoney(cashBefore + breakdown.cashReceiptDelta);

      if (breakdown.capitalPrice > 0) {
        writer.update(depAccRef, {
          balance: depAfter,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
        writer.set(depLedgerRef, {
          ...meta,
          transactionNumber: `${meta.transactionNumber}-M`.slice(0, 40),
          accountId: input.depositAccount.id,
          accountName: depAccData.name.slice(0, 80),
          direction: 'out',
          amount: breakdown.capitalPrice,
          balanceBefore: depBefore,
          balanceAfter: depAfter,
          sourceModule: 'ppob',
          referenceId: txId,
          description: `Modal PPOB ${categoryLabel} ${cleanProvider} (${cleanTarget})`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }

      if (breakdown.cashReceiptDelta > 0) {
        writer.update(cashAccRef, {
          balance: cashAfter,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
        writer.set(cashLedgerRef, {
          ...meta,
          transactionNumber: `${meta.transactionNumber}-J`.slice(0, 40),
          accountId: input.cashAccount.id,
          accountName: cashAccData.name.slice(0, 80),
          direction: 'in',
          amount: breakdown.cashReceiptDelta,
          balanceBefore: cashBefore,
          balanceAfter: cashAfter,
          sourceModule: 'ppob',
          referenceId: txId,
          description: `${
            breakdown.paymentStatus === 'debt' ? 'DP Bon PPOB' : 'Terima PPOB'
          } ${categoryLabel} ${cleanProvider} (${cleanTarget})`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }
    }

    if (willAutoCreateCustomer && resolvedCustomerId) {
      finalCustomerDebtAfter = breakdown.debtAmount;
      writer.set(doc(db, 'customers', resolvedCustomerId), {
        name: effectiveCustomerName,
        ...(cleanNewCustomerPhone ? { phone: cleanNewCustomerPhone } : {}),
        totalDebt: breakdown.debtAmount,
        createdByUid: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else if (input.customer && breakdown.debtAmount > 0) {
      const prevDebt = roundMoney(Math.max(0, Number(liveCustomerData?.totalDebt) || 0));
      finalCustomerDebtAfter = roundMoney(prevDebt + breakdown.debtAmount);
      writer.update(doc(db, 'customers', input.customer.id), {
        totalDebt: finalCustomerDebtAfter,
        updatedAt: serverTimestamp(),
      });
    } else if (input.customer) {
      finalCustomerDebtAfter = roundMoney(Math.max(0, Number(liveCustomerData?.totalDebt) || 0));
    }

    if (breakdown.debtAmount > 0 && resolvedCustomerId) {
      const recId = generateSafeId('rec');
      const recMeta = createTransactionMetadata('KBN', user);
      const debtBalanceAfter = finalCustomerDebtAfter ?? breakdown.debtAmount;
      writer.set(doc(db, 'receivables', recId), {
        ...recMeta,
        customerId: resolvedCustomerId,
        customerName: effectiveCustomerName,
        type: 'debt',
        amount: breakdown.debtAmount,
        balanceAfter: debtBalanceAfter,
        sourceType: 'ppob',
        referenceId: txId,
        ...(breakdown.paidAmount > 0 ? { accountId: input.cashAccount.id } : {}),
        notes: (
          breakdown.paidAmount > 0
            ? `Bon PPOB ${cleanProvider} (${cleanTarget}) · ${meta.transactionNumber} (Tagihan ${formatRupiah(
                breakdown.customerTotal
              )}, DP ${formatRupiah(breakdown.paidAmount)})`
            : `Bon PPOB ${cleanProvider} (${cleanTarget}) · ${meta.transactionNumber}`
        ).slice(0, 240),
        createdAt: serverTimestamp(),
      });
    }

    writer.set(txRef, {
      ...meta,
      category: input.category,
      providerName: cleanProvider,
      targetNumber: cleanTarget,
      ...(resolvedCustomerId ? { customerId: resolvedCustomerId } : {}),
      ...(effectiveCustomerName ? { customerName: effectiveCustomerName } : {}),
      paymentStatus: breakdown.paymentStatus,
      capitalPrice: breakdown.capitalPrice,
      sellPrice: breakdown.sellPrice,
      adminFee: breakdown.adminFee,
      paidAmount: breakdown.paidAmount,
      debtAmount: breakdown.debtAmount,
      netProfit: breakdown.netProfit,
      accountId: input.depositAccount.id,
      cashAccountId: input.cashAccount.id,
      ...(cleanSn ? { serialNumber: cleanSn } : {}),
      status: input.status,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  };

  const executeOfflineBatch = async () => {
    const batch = writeBatch(db);
    applyWrites(input.depositAccount, input.cashAccount, input.customer || null, {
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
          if (sameAccount) {
            const [depSnap, custSnap] = await Promise.all([
              tx.get(depAccRef),
              customerRef ? tx.get(customerRef) : Promise.resolve(null),
            ]);
            if (!depSnap.exists()) {
              throw new Error('Akun deposit/kas PPOB tidak ditemukan.');
            }
            const accData = depSnap.data() as Account;
            const liveCust =
              custSnap && custSnap.exists() ? (custSnap.data() as Customer) : input.customer || null;
            applyWrites(accData, accData, liveCust, {
              set: (ref, data) => tx.set(ref, data),
              update: (ref, data) => tx.update(ref, data),
            });
          } else {
            const [depSnap, cashSnap, custSnap] = await Promise.all([
              tx.get(depAccRef),
              tx.get(cashAccRef),
              customerRef ? tx.get(customerRef) : Promise.resolve(null),
            ]);
            if (!depSnap.exists()) {
              throw new Error('Akun deposit PPOB tidak ditemukan.');
            }
            if (!cashSnap.exists()) {
              throw new Error('Akun kas penerima bayar tidak ditemukan.');
            }
            const liveCust =
              custSnap && custSnap.exists() ? (custSnap.data() as Customer) : input.customer || null;
            applyWrites(depSnap.data() as Account, cashSnap.data() as Account, liveCust, {
              set: (ref, data) => tx.set(ref, data),
              update: (ref, data) => tx.update(ref, data),
            });
          }
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
      txId,
      transactionNumber: meta.transactionNumber,
      netProfit: breakdown.netProfit,
      customerTotal: breakdown.customerTotal,
      paymentStatus: breakdown.paymentStatus,
      paidAmount: breakdown.paidAmount,
      debtAmount: breakdown.debtAmount,
      customerId: resolvedCustomerId,
      customerName: effectiveCustomerName || undefined,
      customerDebtAfter: breakdown.debtAmount > 0 ? finalCustomerDebtAfter : undefined,
    };
  } catch (error) {
    if (error instanceof Error && !error.message.includes('Missing or insufficient permissions')) {
      throw error;
    }
    handleFirestoreError(error, OperationType.WRITE, `ppob_transactions/${txId}`);
  }
}

export async function completePendingPpobTransaction(
  txDoc: PpobTransaction,
  serialNumber: string
): Promise<void> {
  if (txDoc.status === 'failed') {
    throw new Error('Transaksi gagal tidak dapat diubah menjadi sukses.');
  }
  const cleanSn = serialNumber.trim().slice(0, 100);
  const txRef = doc(db, 'ppob_transactions', txDoc.id);
  try {
    await updateDoc(txRef, {
      status: 'completed',
      ...(cleanSn ? { serialNumber: cleanSn } : {}),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `ppob_transactions/${txDoc.id}`);
  }
}

export async function failAndRefundPpobTransaction(
  txDoc: PpobTransaction,
  accounts: Account[],
  user: { uid: string; displayName: string },
  customers: Customer[] = []
): Promise<void> {
  if (txDoc.status === 'failed') {
    throw new Error('Transaksi PPOB ini sudah berstatus gagal / refund.');
  }

  const breakdown = calculatePpobBreakdown({
    capitalPrice: txDoc.capitalPrice,
    sellPrice: txDoc.sellPrice,
    adminFee: txDoc.adminFee,
    paymentStatus: txDoc.paymentStatus || 'paid',
    paidAmount: txDoc.paidAmount,
  });

  const cashToRefund = breakdown.cashReceiptDelta;
  const originalDebt = roundMoney(Math.max(0, Number(txDoc.debtAmount) || 0));

  const depositAccId = txDoc.accountId;
  const cashAccId = txDoc.cashAccountId || '';
  const sameAccount = Boolean(cashAccId && cashAccId === depositAccId);
  const meta = createTransactionMetadata('RPPB', user);

  const txRef = doc(db, 'ppob_transactions', txDoc.id);
  const depAccRef = doc(db, 'accounts', depositAccId);
  const cashAccRef = cashAccId ? doc(db, 'accounts', cashAccId) : null;
  const custRef =
    originalDebt > 0 && txDoc.customerId ? doc(db, 'customers', txDoc.customerId) : null;
  const depLedgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));
  const cashLedgerRef = doc(db, 'cash_ledger', generateSafeId('ldg'));

  const applyRefundWrites = (
    depAccData: Pick<Account, 'name' | 'balance'>,
    cashAccData: Pick<Account, 'name' | 'balance'> | null,
    custData: Pick<Customer, 'name' | 'totalDebt'> | null,
    writer: {
      set: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
      update: (ref: ReturnType<typeof doc>, data: Record<string, unknown>) => void;
    }
  ) => {
    const depBefore = roundMoney(Number(depAccData.balance) || 0);

    if (sameAccount) {
      const mergedAfter = roundMoney(depBefore + breakdown.capitalPrice - cashToRefund);
      if (mergedAfter < 0) {
        throw new Error(
          `Saldo ${depAccData.name} (${formatRupiah(depBefore)}) tidak mencukupi untuk refund pelanggan.`
        );
      }
      if (breakdown.capitalPrice > 0 || cashToRefund > 0) {
        writer.update(depAccRef, {
          balance: mergedAfter,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
      }

      if (breakdown.capitalPrice > 0) {
        const midBal = roundMoney(depBefore + breakdown.capitalPrice);
        writer.set(depLedgerRef, {
          ...meta,
          transactionNumber: `${meta.transactionNumber}-M`.slice(0, 40),
          accountId: depositAccId,
          accountName: depAccData.name.slice(0, 80),
          direction: 'in',
          amount: breakdown.capitalPrice,
          balanceBefore: depBefore,
          balanceAfter: midBal,
          sourceModule: 'ppob',
          referenceId: txDoc.id,
          description: `Refund modal PPOB gagal ${txDoc.transactionNumber}`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }

      if (cashToRefund > 0) {
        const midBal = roundMoney(depBefore + breakdown.capitalPrice);
        writer.set(cashLedgerRef, {
          ...meta,
          transactionNumber: `${meta.transactionNumber}-J`.slice(0, 40),
          accountId: depositAccId,
          accountName: depAccData.name.slice(0, 80),
          direction: 'out',
          amount: cashToRefund,
          balanceBefore: midBal,
          balanceAfter: mergedAfter,
          sourceModule: 'ppob',
          referenceId: txDoc.id,
          description: `Refund bayar pelanggan PPOB gagal ${txDoc.transactionNumber}`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }
    } else {
      const depAfter = roundMoney(depBefore + breakdown.capitalPrice);
      if (breakdown.capitalPrice > 0) {
        writer.update(depAccRef, {
          balance: depAfter,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
        writer.set(depLedgerRef, {
          ...meta,
          transactionNumber: `${meta.transactionNumber}-M`.slice(0, 40),
          accountId: depositAccId,
          accountName: depAccData.name.slice(0, 80),
          direction: 'in',
          amount: breakdown.capitalPrice,
          balanceBefore: depBefore,
          balanceAfter: depAfter,
          sourceModule: 'ppob',
          referenceId: txDoc.id,
          description: `Refund modal PPOB gagal ${txDoc.transactionNumber}`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }

      if (cashAccRef && cashAccData && cashToRefund > 0) {
        const cashBefore = roundMoney(Number(cashAccData.balance) || 0);
        const cashAfter = roundMoney(cashBefore - cashToRefund);
        if (cashAfter < 0) {
          throw new Error(
            `Saldo ${cashAccData.name} (${formatRupiah(cashBefore)}) tidak mencukupi untuk mengembalikan pembayaran pelanggan ${formatRupiah(
              cashToRefund
            )}.`
          );
        }
        writer.update(cashAccRef, {
          balance: cashAfter,
          updatedByUid: user.uid,
          updatedAt: serverTimestamp(),
        });
        writer.set(cashLedgerRef, {
          ...meta,
          transactionNumber: `${meta.transactionNumber}-J`.slice(0, 40),
          accountId: cashAccId,
          accountName: cashAccData.name.slice(0, 80),
          direction: 'out',
          amount: cashToRefund,
          balanceBefore: cashBefore,
          balanceAfter: cashAfter,
          sourceModule: 'ppob',
          referenceId: txDoc.id,
          description: `Refund bayar pelanggan PPOB gagal ${txDoc.transactionNumber}`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }
    }

    if (custRef && custData && originalDebt > 0) {
      const liveDebt = roundMoney(Math.max(0, Number(custData.totalDebt) || 0));
      const debtToReduce = roundMoney(Math.min(liveDebt, originalDebt));
      if (debtToReduce > 0) {
        const balanceAfter = roundMoney(Math.max(0, liveDebt - debtToReduce));
        writer.update(custRef, {
          totalDebt: balanceAfter,
          updatedAt: serverTimestamp(),
        });
        const recMeta = createTransactionMetadata('KRP', user);
        writer.set(doc(db, 'receivables', generateSafeId('rec')), {
          ...recMeta,
          customerId: txDoc.customerId!,
          customerName: (custData.name || txDoc.customerName || 'Pelanggan').slice(0, 100),
          type: 'payment',
          amount: debtToReduce,
          balanceAfter,
          sourceType: 'ppob',
          referenceId: txDoc.id,
          notes: `Refund/Pembatalan Bon PPOB gagal ${txDoc.transactionNumber}`.slice(0, 240),
          createdAt: serverTimestamp(),
        });
      }
    }

    writer.update(txRef, {
      status: 'failed',
      updatedAt: serverTimestamp(),
    });
  };

  const executeOfflineBatch = async () => {
    const depAcc = accounts.find((a) => a.id === depositAccId);
    const cashAcc = cashAccId ? accounts.find((a) => a.id === cashAccId) || null : null;
    if (!depAcc) {
      throw new Error('Akun deposit PPOB terkait tidak ditemukan.');
    }
    const cust = txDoc.customerId ? customers.find((c) => c.id === txDoc.customerId) || null : null;
    const batch = writeBatch(db);
    applyRefundWrites(depAcc, cashAcc, cust, {
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
          const [txSnap, depSnap, cashSnap, custSnap] = await Promise.all([
            tx.get(txRef),
            tx.get(depAccRef),
            !sameAccount && cashAccRef ? tx.get(cashAccRef) : Promise.resolve(null),
            custRef ? tx.get(custRef) : Promise.resolve(null),
          ]);

          if (!txSnap.exists()) {
            throw new Error('Transaksi PPOB tidak ditemukan.');
          }
          if ((txSnap.data() as PpobTransaction).status === 'failed') {
            throw new Error('Transaksi PPOB ini sudah berstatus gagal.');
          }
          if (!depSnap.exists()) {
            throw new Error('Akun deposit PPOB tidak ditemukan.');
          }

          const custData = custSnap && custSnap.exists() ? (custSnap.data() as Customer) : null;

          applyRefundWrites(
            depSnap.data() as Account,
            sameAccount
              ? (depSnap.data() as Account)
              : cashSnap && cashSnap.exists()
              ? (cashSnap.data() as Account)
              : null,
            custData,
            {
              set: (ref, data) => tx.set(ref, data),
              update: (ref, data) => tx.update(ref, data),
            }
          );
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
    handleFirestoreError(error, OperationType.UPDATE, `ppob_transactions/${txDoc.id}`);
  }
}
