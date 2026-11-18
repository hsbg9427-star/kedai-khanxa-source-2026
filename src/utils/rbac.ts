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

export function canAccessNavTab(tab: NavTab, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !ADMIN_ONLY_TABS.includes(tab);
}

export function resolveSafeNavTab(tab: NavTab, isAdmin: boolean): NavTab {
  return canAccessNavTab(tab, isAdmin) ? tab : 'dashboard';
}
