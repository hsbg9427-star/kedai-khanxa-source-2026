import type { Timestamp } from 'firebase/firestore';

export type UserRole = 'admin' | 'kasir' | 'pending';
export type UserStatus = 'active' | 'inactive' | 'pending';

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  photoURL?: string;
  role: UserRole;
  status: UserStatus;
  shiftLabel?: string;
  phone?: string;
  claimedInviteId?: string;
  isPrimaryAdmin?: boolean;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface SystemBootstrapConfig {
  primaryAdminUid: string;
  claimedAt: Timestamp;
}

export interface StaffInvite {
  id: string;
  email: string;
  displayName: string;
  role: 'admin' | 'kasir';
  shiftLabel?: string;
  status: 'pending' | 'claimed';
  invitedByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export type HppMethod = 'moving_average' | 'fifo';

export interface StoreSetting {
  storeName: string;
  ownerName: string;
  address?: string;
  phone?: string;
  receiptHeader?: string; // Sub-header / Slogan struk kustom (contoh: Solusi Belanja Hemat & Nyaman)
  receiptThankYou?: string; // Pesan terima kasih kustom (contoh: Terima kasih atas kunjungan Anda!)
  receiptFooter?: string; // Catatan kaki / info penukaran barang / garansi
  qrisFeePercent?: number;
  hppMethod?: HppMethod;
  dailySalesTarget?: number;
  updatedByUid: string;
  updatedAt: Timestamp;
}

export type ResetOptionType =
  | 'products_stock'
  | 'purchases_history'
  | 'sales_history'
  | 'accounts_balance_mutation'
  | 'customers_receivables'
  | 'mini_atm'
  | 'ppob'
  | 'stock_fifo_history'
  | 'all_operational';

export interface ResetAuditLog {
  id: string;
  resetType: ResetOptionType | string;
  resetLabel: string;
  itemsDeletedCount: number;
  details: string;
  recordedByUid: string;
  recordedByName: string;
  createdAt: Timestamp;
}

export type AccountType = 'cash' | 'bank' | 'ewallet' | 'ppob_deposit';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  accountNumber?: string;
  balance: number;
  isActive: boolean;
  updatedByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface TransactionMetadata {
  transactionNumber: string;
  transactionDate: string; // YYYY-MM-DD
  transactionTime: string; // HH:mm:ss
  recordedByUid: string;
  recordedByName: string;
}

export interface Category {
  id: string;
  name: string;
  description?: string;
  createdByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface ProductSellUnit {
  unitName: string;
  conversion: number; // konversi ke satuan dasar (contoh: 1 DUS = 40 PCS, atau 1 BATANG = 0.05 BUNGKUS)
  buyPrice?: number; // harga beli per satuan ini (opsional, untuk autofill Pembelian)
  sellPrice: number; // harga jual ecer satuan ini
  wholesalePrice?: number; // harga grosir satuan ini
  wholesaleMinQty?: number; // minimal beli satuan ini untuk harga grosir
  canBuy?: boolean; // dapat dipilih pada transaksi Pembelian (default true)
  canSell?: boolean; // dapat dipilih pada transaksi Kasir/Penjualan (default true)
  conversionMode?: 'multiply' | 'divide'; // 'multiply': 1 unit = N dasar; 'divide': 1 dasar = N unit
  perBaseQty?: number; // isi per satuan dasar saat conversionMode === 'divide' (mis. 20 batang/bungkus)
}

export interface Product {
  id: string;
  sku: string;
  barcode?: string;
  name: string;
  photoDataUrl?: string;
  categoryId: string;
  categoryName: string;
  unit: string; // satuan dasar (contoh: PCS, BUNGKUS, GRAM, ML, BOTOL, BUTIR)
  baseCanBuy?: boolean; // apakah satuan dasar dapat dipilih di Pembelian (default true)
  baseCanSell?: boolean; // apakah satuan dasar dapat dipilih di Kasir/Penjualan (default true)
  costPrice: number; // harga modal per satuan dasar
  sellPrice: number; // harga ecer per satuan dasar
  wholesalePrice?: number; // harga grosir per satuan dasar
  wholesaleMinQty?: number; // minimal beli satuan dasar untuk harga grosir
  sellUnits?: ProductSellUnit[]; // satuan tambahan (SLOP, BATANG, KG, KARUNG, LITER, DUS, RAK, dll)
  stock: number; // selalu disimpan dalam satuan dasar
  minStock: number;
  isActive: boolean;
  createdByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PriceHistory extends TransactionMetadata {
  id: string;
  productId: string;
  productName: string;
  baseUnit: string;
  changeType: 'initial' | 'update';
  costPriceBefore: number;
  costPriceAfter: number;
  sellPriceBefore: number;
  sellPriceAfter: number;
  wholesalePriceBefore?: number;
  wholesalePriceAfter?: number;
  summary: string;
  createdAt: Timestamp;
}

export interface StockMovement extends TransactionMetadata {
  id: string;
  productId: string;
  productName: string;
  baseUnit?: string;
  unitName?: string;
  unitQuantity?: number;
  conversion?: number;
  type: 'in' | 'out' | 'adjustment';
  quantity: number; // jumlah dalam satuan dasar
  stockBefore: number;
  stockAfter: number;
  referenceId?: string;
  notes?: string;
  createdAt: Timestamp;
}

export type StockOpnameStatus = 'draft' | 'finalized';
export type StockOpnameVarianceStatus = 'uncounted' | 'match' | 'surplus' | 'deficit';

export interface StockOpname extends TransactionMetadata {
  id: string;
  title: string;
  categoryFilterId?: string;
  categoryFilterName?: string;
  status: StockOpnameStatus;
  startedAtMs: number;
  lastSavedAt?: Timestamp;
  finalizedAt?: Timestamp;
  finalizedByUid?: string;
  finalizedByName?: string;
  finalizedDate?: string;
  finalizedTime?: string;
  totalProducts: number;
  countedProducts: number;
  matchedCount: number;
  surplusCount: number;
  deficitCount: number;
  totalVarianceValue: number;
  notes?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface StockOpnameItem {
  id: string;
  opnameId: string;
  productId: string;
  sku: string;
  barcode?: string;
  productName: string;
  categoryId: string;
  categoryName: string;
  baseUnit: string;
  costPrice: number;
  systemStockAtStart: number;
  systemStockAtCount: number;
  movementSinceStart: number;
  physicalUnitName: string;
  physicalUnitQty: number;
  physicalSubUnitName?: string;
  physicalSubUnitQty?: number;
  physicalStockBase?: number;
  varianceBase: number;
  varianceStatus: StockOpnameVarianceStatus;
  finalStockApplied?: number;
  reason?: string;
  isCounted: boolean;
  countedAtMs?: number;
  recordedByUid: string;
  updatedAt: Timestamp;
}

export interface Sale extends TransactionMetadata {
  id: string;
  customerId?: string;
  customerName?: string;
  totalItems: number;
  subtotal: number;
  discount: number;
  totalAmount: number;
  totalCost?: number;
  totalProfit?: number;
  paidAmount: number;
  changeAmount: number;
  debtAmount: number;
  paymentMethod: 'cash' | 'transfer' | 'qris' | 'mixed' | 'debt';
  cashPaidPart?: number;
  qrisAmount?: number;
  qrisFeeRate?: number;
  qrisFeeAmount?: number;
  netReceivedAmount?: number;
  accountId?: string;
  qrisAccountId?: string;
  status: 'completed' | 'void';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface SaleItem {
  id: string;
  saleId: string;
  productId: string;
  productName: string;
  unitName?: string;
  conversion?: number;
  baseQuantity?: number;
  priceTier?: 'retail' | 'wholesale';
  quantity: number;
  costPrice: number;
  unitPrice: number;
  subtotal: number;
  profit?: number;
  recordedByUid: string;
  createdAt: Timestamp;
}

export interface Purchase extends TransactionMetadata {
  id: string;
  invoiceNumber?: string;
  supplierId?: string;
  supplierName: string;
  subtotal?: number;
  discount?: number;
  extraCost?: number;
  totalAmount: number;
  paidAmount?: number;
  debtAmount?: number;
  returnedAmount?: number;
  paymentMethod: 'cash' | 'transfer' | 'credit' | 'partial';
  paymentStatus?: 'paid' | 'partial' | 'unpaid';
  accountId?: string;
  accountName?: string;
  notes?: string;
  status: 'completed' | 'void';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PurchaseItem {
  id: string;
  purchaseId: string;
  productId: string;
  productName: string;
  unitName?: string;
  baseUnit?: string;
  conversion?: number;
  baseQuantity?: number;
  quantity: number;
  unitCost: number;
  lineDiscount?: number;
  allocatedExtraCost?: number;
  netLineTotal?: number;
  effectiveBaseUnitCost?: number;
  hppBefore?: number;
  hppAfter?: number;
  subtotal: number;
  recordedByUid: string;
  createdAt: Timestamp;
}

export interface Supplier {
  id: string;
  name: string;
  phone?: string;
  address?: string;
  notes?: string;
  totalDebt: number;
  createdByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface SupplierPayment extends TransactionMetadata {
  id: string;
  purchaseId: string;
  purchaseNumber: string;
  invoiceNumber?: string;
  supplierId?: string;
  supplierName: string;
  amount: number;
  debtBefore: number;
  debtAfter: number;
  accountId: string;
  accountName: string;
  notes?: string;
  createdAt: Timestamp;
}

export interface PurchaseReturn extends TransactionMetadata {
  id: string;
  purchaseId: string;
  purchaseNumber: string;
  supplierId?: string;
  supplierName: string;
  productId: string;
  productName: string;
  unitName: string;
  baseUnit: string;
  conversion: number;
  returnQty: number;
  returnBaseQty: number;
  unitRefundPrice: number;
  refundTotal: number;
  settlementType: 'reduce_debt' | 'cash_refund' | 'mixed';
  debtReducedAmount: number;
  cashRefundAmount: number;
  accountId?: string;
  accountName?: string;
  reason?: string;
  createdAt: Timestamp;
}

export interface Customer {
  id: string;
  name: string;
  phone?: string;
  address?: string;
  totalDebt: number;
  notes?: string;
  createdByUid: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Receivable extends TransactionMetadata {
  id: string;
  customerId: string;
  customerName: string;
  type: 'debt' | 'payment';
  amount: number;
  balanceAfter: number;
  saleId?: string;
  accountId?: string;
  notes?: string;
  createdAt: Timestamp;
}

export type MiniAtmPaymentChannel = 'bank_transfer' | 'qris';

export interface MiniAtmFeeTier {
  id: string;
  serviceScope: 'all' | 'tarik_tunai' | 'transfer';
  minAmount: number;
  maxAmount: number; // 0 berarti tidak terbatas (ke atas)
  adminFee: number;
  bankFee?: number;
}

export interface MiniAtmBankFeeRule {
  bankName: string;
  defaultBankFee: number;
}

export interface MiniAtmSetting {
  id: string;
  allowQrisTarikTunai: boolean;
  qrisProviderNote?: string;
  qrisMdrPercent: number;
  qrisInternalExtraThreshold: number;
  qrisInternalExtraFee: number;
  defaultTarikTunaiFee: number;
  defaultTransferFee: number;
  feeTiers: MiniAtmFeeTier[];
  bankFeeRules: MiniAtmBankFeeRule[];
  updatedByUid: string;
  updatedByName?: string;
  updatedAt: Timestamp;
}

export interface MiniAtmFeeAudit extends TransactionMetadata {
  id: string;
  miniAtmTxId: string;
  serviceType: 'tarik_tunai' | 'transfer' | 'setor_tunai';
  bankName: string;
  principalAmount: number;
  standardAdminFee: number;
  appliedAdminFee: number;
  standardBankFee: number;
  appliedBankFee: number;
  reason?: string;
  createdAt: Timestamp;
}

export interface MiniAtmTransaction extends TransactionMetadata {
  id: string;
  serviceType: 'tarik_tunai' | 'transfer' | 'setor_tunai';
  paymentChannel?: MiniAtmPaymentChannel;
  bankName: string;
  targetAccountNumber?: string;
  customerName?: string;
  principalAmount: number;
  adminFee: number;
  bankFee: number;
  qrisVerified?: boolean;
  transferVerified?: boolean;
  qrisMdrRate?: number;
  qrisMdrAmount?: number;
  internalExtraFee?: number;
  externalReferenceNumber?: string;
  transferProofDataUrl?: string;
  standardAdminFee?: number;
  standardBankFee?: number;
  feeOverridden?: boolean;
  feeOverrideReason?: string;
  netProfit: number;
  cashAccountId: string;
  bankAccountId: string;
  notes?: string;
  status: 'completed' | 'void';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface PpobTransaction extends TransactionMetadata {
  id: string;
  category: 'pulsa' | 'paket_data' | 'pln' | 'pdam' | 'bpjs' | 'ewallet' | 'lainnya';
  providerName: string;
  targetNumber: string;
  customerName?: string;
  capitalPrice: number;
  sellPrice: number;
  adminFee: number;
  netProfit: number;
  accountId: string;
  cashAccountId?: string;
  serialNumber?: string;
  status: 'completed' | 'pending' | 'failed';
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface Loan extends TransactionMetadata {
  id: string;
  borrowerName: string;
  borrowerPhone?: string;
  loanDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  principalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  sourceAccountId: string;
  sourceAccountName: string;
  sourceAccountType: AccountType;
  status: 'unpaid' | 'partial' | 'paid';
  notes?: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface LoanPayment extends TransactionMetadata {
  id: string;
  loanId: string;
  loanNumber: string;
  borrowerName: string;
  amount: number;
  remainingBefore: number;
  remainingAfter: number;
  accountId: string;
  accountName: string;
  notes?: string;
  createdAt: Timestamp;
}

export interface CashLedger extends TransactionMetadata {
  id: string;
  accountId: string;
  accountName: string;
  direction: 'in' | 'out';
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  sourceModule:
    | 'sale'
    | 'purchase'
    | 'mini_atm'
    | 'ppob'
    | 'expense'
    | 'receivable'
    | 'capital'
    | 'transfer'
    | 'loan';
  referenceId?: string;
  description: string;
  createdAt: Timestamp;
}

export interface Expense extends TransactionMetadata {
  id: string;
  category: string;
  description: string;
  amount: number;
  accountId: string;
  accountName: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

export interface FinancialSummary {
  id: string;
  periodType: 'daily' | 'monthly';
  periodKey: string;
  totalSales: number;
  totalPurchases: number;
  totalMiniAtmVolume: number;
  totalMiniAtmProfit: number;
  totalPpobVolume: number;
  totalPpobProfit: number;
  totalExpenses: number;
  netProfit: number;
  updatedByUid: string;
  updatedAt: Timestamp;
}
