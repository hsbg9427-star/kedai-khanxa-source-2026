import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { NetworkProvider, useNetwork } from './contexts/NetworkContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AppShell, type NavTab } from './components/AppShell';
import { OfflineIndicator } from './components/OfflineIndicator';
import { LoginPage } from './pages/LoginPage';
import { PendingAccessPage } from './pages/PendingAccessPage';
import { DashboardPage } from './pages/DashboardPage';
import { AccountsPage } from './pages/AccountsPage';
import { UsersPage } from './pages/UsersPage';
import { SettingsPage } from './pages/SettingsPage';
import { ProductsPage } from './pages/ProductsPage';
import { PosPage } from './pages/PosPage';
import { CustomersPage } from './pages/CustomersPage';
import { LoansPage } from './pages/LoansPage';
import { ReportsPage } from './pages/ReportsPage';
import { MiniAtmPage } from './pages/MiniAtmPage';
import { PpobPage } from './pages/PpobPage';
import { PurchasesPage } from './pages/PurchasesPage';
import { StockOpnamePage } from './pages/StockOpnamePage';
import { ClosingKasirPage } from './pages/ClosingKasirPage';
import { canAccessNavTab, parseNavTab, resolveSafeNavTab } from './utils/rbac';
import type {
  Account,
  Category,
  Customer,
  Product,
  StockBatch,
  StoreSetting,
} from './types/database';
import {
  subscribeAccounts,
  subscribeStoreSettings,
  subscribeTodayDashboardMetrics,
  type TodayDashboardMetrics,
} from './services/warungService';
import {
  ensureDefaultCategories,
  subscribeCategories,
  subscribeProducts,
} from './services/inventoryService';
import { subscribeStockBatches } from './services/batchService';
import { subscribeCustomers } from './services/receivableService';
import { collectExpiryAlerts } from './utils/expiryUtils';
import { getTodayDateString } from './utils/formatters';

const INITIAL_METRICS: TodayDashboardMetrics = {
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

function AuthenticatedWorkspace() {
  const { user, isAdmin, isActiveStaff } = useAuth();
  const { markPendingWrite } = useNetwork();

  const [activeTab, setActiveTab] = useState<NavTab>(() => {
    if (typeof window === 'undefined') return 'dashboard';
    return parseNavTab(window.history.state?.tab ?? window.location.hash, isAdmin);
  });
  const historySeededRef = useRef(false);
  const [storeSetting, setStoreSetting] = useState<StoreSetting | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsPendingWrites, setAccountsPendingWrites] = useState(false);

  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesLoaded, setCategoriesLoaded] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [productsLoading, setProductsLoading] = useState(true);
  const [productsPendingWrites, setProductsPendingWrites] = useState(false);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(true);
  const [customersPendingWrites, setCustomersPendingWrites] = useState(false);
  const [stockBatches, setStockBatches] = useState<StockBatch[]>([]);
  const [batchesPendingWrites, setBatchesPendingWrites] = useState(false);

  const [metrics, setMetrics] = useState<TodayDashboardMetrics>(INITIAL_METRICS);
  const seededDefaultsRef = useRef(false);

  useEffect(() => {
    markPendingWrite(
      accountsPendingWrites ||
        productsPendingWrites ||
        customersPendingWrites ||
        batchesPendingWrites
    );
  }, [
    accountsPendingWrites,
    productsPendingWrites,
    customersPendingWrites,
    batchesPendingWrites,
    markPendingWrite,
  ]);

  useEffect(() => {
    if (!user || !isActiveStaff) {
      seededDefaultsRef.current = false;
      return;
    }

    setAccountsLoading(true);
    setProductsLoading(true);
    setCustomersLoading(true);
    setCategoriesLoaded(false);
    const todayDate = getTodayDateString();

    const unsubStore = subscribeStoreSettings(
      (setting) => setStoreSetting(setting),
      () => {}
    );

    const unsubAccounts = subscribeAccounts(
      (list, pending) => {
        setAccounts(list);
        setAccountsPendingWrites(pending);
        setAccountsLoading(false);
      },
      () => setAccountsLoading(false)
    );

    const unsubCategories = subscribeCategories(
      (list) => {
        setCategories(list);
        setCategoriesLoaded(true);
      },
      () => setCategoriesLoaded(true)
    );

    const unsubProducts = subscribeProducts(
      (list, pending) => {
        setProducts(list);
        setProductsPendingWrites(pending);
        setProductsLoading(false);
      },
      () => setProductsLoading(false)
    );

    const unsubCustomers = subscribeCustomers(
      (list, pending) => {
        setCustomers(list);
        setCustomersPendingWrites(pending);
        setCustomersLoading(false);
      },
      () => setCustomersLoading(false)
    );

    const unsubBatches = subscribeStockBatches(
      (list, pending) => {
        setStockBatches(list);
        setBatchesPendingWrites(pending);
      },
      () => {}
    );

    const unsubMetrics = subscribeTodayDashboardMetrics(
      todayDate,
      user.uid,
      isAdmin,
      (nextMetrics) => setMetrics(nextMetrics)
    );

    return () => {
      unsubStore();
      unsubAccounts();
      unsubCategories();
      unsubProducts();
      unsubCustomers();
      unsubBatches();
      unsubMetrics();
    };
  }, [user, isActiveStaff, isAdmin]);

  useEffect(() => {
    if (!user || !isActiveStaff || !isAdmin || !categoriesLoaded) return;
    if (seededDefaultsRef.current) return;
    seededDefaultsRef.current = true;

    ensureDefaultCategories(categories, user.uid).catch(() => {
      seededDefaultsRef.current = false;
    });
  }, [user, isActiveStaff, isAdmin, categoriesLoaded, categories]);

  useEffect(() => {
    if (!isActiveStaff) {
      historySeededRef.current = false;
      return;
    }
    if (!historySeededRef.current && typeof window !== 'undefined') {
      historySeededRef.current = true;
      const initialTab = parseNavTab(
        window.history.state?.tab ?? window.location.hash,
        isAdmin
      );
      setActiveTab(initialTab);
      const rootUrl = `${window.location.pathname}${window.location.search}`;
      if (!window.history.state?.tab) {
        window.history.replaceState({ tab: 'dashboard' }, '', rootUrl);
        if (initialTab !== 'dashboard') {
          window.history.pushState({ tab: initialTab }, '', `#${initialTab}`);
        }
      }
    }
  }, [isActiveStaff, isAdmin]);

  useEffect(() => {
    if (!isActiveStaff || typeof window === 'undefined') return;
    const handlePopState = (event: PopStateEvent) => {
      const nextTab = parseNavTab(event.state?.tab ?? window.location.hash, isAdmin);
      setActiveTab(nextTab);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [isActiveStaff, isAdmin]);

  if (!isActiveStaff) {
    return <PendingAccessPage />;
  }

  // Pastikan Kasir tidak dapat membuka tab admin-only lewat rute/state apa pun
  const safeTab: NavTab = resolveSafeNavTab(activeTab, isAdmin);

  const handleNavigate = (tab: NavTab) => {
    const target = resolveSafeNavTab(tab, isAdmin);
    if (target === safeTab) return;
    setActiveTab(target);
    if (typeof window !== 'undefined') {
      const targetUrl =
        target === 'dashboard'
          ? `${window.location.pathname}${window.location.search}`
          : `#${target}`;
      window.history.pushState({ tab: target }, '', targetUrl);
      window.scrollTo(0, 0);
    }
  };

  const computedLowStockCount = products.filter(
    (p) => p.isActive && p.stock <= p.minStock
  ).length;
  const liveMetrics: TodayDashboardMetrics = {
    ...metrics,
    lowStockCount: computedLowStockCount,
  };

  const expiryAlerts = useMemo(
    () => collectExpiryAlerts(products, stockBatches),
    [products, stockBatches]
  );

  const handleOpenExpiryMonitoring = () => {
    handleNavigate('dashboard');
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        document.getElementById('monitoring-kedaluwarsa')?.scrollIntoView({ behavior: 'smooth' });
      }, 120);
    }
  };

  const storeName = storeSetting?.storeName || 'KEDAI KHANXA';

  return (
    <AppShell
      activeTab={safeTab}
      onSelectTab={handleNavigate}
      storeName={storeName}
      expiryAlerts={expiryAlerts}
      onOpenExpiryMonitoring={handleOpenExpiryMonitoring}
    >
      {safeTab === 'dashboard' && (
        <DashboardPage
          storeSetting={storeSetting}
          accounts={accounts}
          accountsLoading={accountsLoading}
          customers={customers}
          products={products}
          stockBatches={stockBatches}
          metrics={liveMetrics}
          onNavigate={handleNavigate}
        />
      )}
      {safeTab === 'pos' && (
        <PosPage
          products={products}
          categories={categories}
          accounts={accounts}
          customers={customers}
          storeSetting={storeSetting}
          stockBatches={stockBatches}
        />
      )}
      {safeTab === 'mini_atm' && (
        <MiniAtmPage accounts={accounts} customers={customers} storeSetting={storeSetting} />
      )}
      {safeTab === 'ppob' && (
        <PpobPage accounts={accounts} customers={customers} storeSetting={storeSetting} />
      )}
      {safeTab === 'products' && canAccessNavTab('products', isAdmin) && isAdmin && (
        <ProductsPage
          products={products}
          categories={categories}
          stockBatches={stockBatches}
          loading={productsLoading}
          hasPendingWrites={productsPendingWrites}
          storeName={storeName}
        />
      )}
      {safeTab === 'stock_opname' && canAccessNavTab('stock_opname', isAdmin) && isAdmin && (
        <StockOpnamePage
          products={products}
          categories={categories}
          storeSetting={storeSetting}
        />
      )}
      {safeTab === 'purchases' && isAdmin && (
        <PurchasesPage
          products={products}
          accounts={accounts}
          storeSetting={storeSetting}
          stockBatches={stockBatches}
        />
      )}
      {safeTab === 'customers' && (
        <CustomersPage
          customers={customers}
          loading={customersLoading}
          hasPendingWrites={customersPendingWrites}
          accounts={accounts}
        />
      )}
      {safeTab === 'closing' && <ClosingKasirPage accounts={accounts} />}
      {safeTab === 'loans' && isAdmin && <LoansPage accounts={accounts} />}
      {safeTab === 'accounts' && isAdmin && (
        <AccountsPage
          accounts={accounts}
          loading={accountsLoading}
          hasPendingWrites={accountsPendingWrites}
        />
      )}
      {safeTab === 'reports' && isAdmin && (
        <ReportsPage
          accounts={accounts}
          customers={customers}
          storeSetting={storeSetting}
          products={products}
          categories={categories}
          stockBatches={stockBatches}
        />
      )}
      {safeTab === 'users' && isAdmin && <UsersPage />}
      {safeTab === 'settings' && canAccessNavTab('settings', isAdmin) && isAdmin && (
        <SettingsPage
          storeSetting={storeSetting}
          categories={categories}
          products={products}
        />
      )}
    </AppShell>
  );
}

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white border border-slate-200 rounded-xl px-6 py-5 text-sm text-slate-600 flex items-center gap-3">
          <div className="w-4 h-4 rounded-full border-2 border-emerald-700 border-t-transparent animate-spin" />
          <span>Memuat sesi dan menyinkronkan database...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <AuthenticatedWorkspace />;
}

export default function App() {
  return (
    <ErrorBoundary>
      <NetworkProvider>
        <AuthProvider>
          <AppContent />
          <OfflineIndicator />
        </AuthProvider>
      </NetworkProvider>
    </ErrorBoundary>
  );
}
