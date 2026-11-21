export type NavTab =
  | 'dashboard'
  | 'pos'
  | 'mini_atm'
  | 'ppob'
  | 'products'
  | 'stock_opname'
  | 'purchases'
  | 'customers'
  | 'loans'
  | 'accounts'
  | 'closing'
  | 'reports'
  | 'users'
  | 'settings';

export const ADMIN_ONLY_TABS: readonly NavTab[] = [
  'products',
  'stock_opname',
  'purchases',
  'loans',
  'accounts',
  'reports',
  'users',
  'settings',
];

export const KASIR_ALLOWED_TABS: readonly NavTab[] = [
  'dashboard',
  'pos',
  'mini_atm',
  'ppob',
  'customers',
  'closing',
];

export const ALL_NAV_TABS: readonly NavTab[] = [
  ...KASIR_ALLOWED_TABS,
  ...ADMIN_ONLY_TABS,
];

export function canAccessNavTab(tab: NavTab, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !ADMIN_ONLY_TABS.includes(tab);
}

export function resolveSafeNavTab(tab: NavTab, isAdmin: boolean): NavTab {
  return canAccessNavTab(tab, isAdmin) ? tab : 'dashboard';
}

export function parseNavTab(raw: unknown, isAdmin: boolean): NavTab {
  if (typeof raw !== 'string') return 'dashboard';
  const cleaned = raw.replace(/^#/, '').trim();
  if (!ALL_NAV_TABS.includes(cleaned as NavTab)) {
    return 'dashboard';
  }
  return resolveSafeNavTab(cleaned as NavTab, isAdmin);
}
