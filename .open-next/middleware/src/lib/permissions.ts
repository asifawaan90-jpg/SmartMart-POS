// Role-based permission matrix — enforced SERVER-SIDE per API group.
export type Perm =
  | 'pos'
  | 'products'
  | 'inventory'
  | 'sales'
  | 'sales_return'
  | 'purchases'
  | 'customers'
  | 'khata'
  | 'khata_manage'
  | 'suppliers'
  | 'expenses'
  | 'reports'
  | 'settings'
  | 'users'

export const ROLE_PERMS: Record<string, Perm[]> = {
  OWNER: [
    'pos', 'products', 'inventory', 'sales', 'sales_return', 'purchases',
    'customers', 'khata', 'khata_manage', 'suppliers', 'expenses', 'reports', 'settings', 'users',
  ],
  MANAGER: [
    'pos', 'products', 'inventory', 'sales', 'sales_return', 'purchases',
    'customers', 'khata', 'khata_manage', 'suppliers', 'expenses', 'reports', 'users',
  ],
  CASHIER: ['pos', 'sales', 'customers'],
  INVENTORY_STAFF: ['products', 'inventory', 'purchases', 'suppliers'],
  ACCOUNTANT: ['reports', 'expenses', 'sales', 'purchases', 'customers', 'khata', 'suppliers'],
}

export function hasPerm(role: string, extraPerms: string[], perm: Perm): boolean {
  if (role === 'OWNER') return true
  if (extraPerms.includes(perm)) return true
  return (ROLE_PERMS[role] || []).includes(perm)
}

export const ALL_ROLES = ['OWNER', 'MANAGER', 'CASHIER', 'INVENTORY_STAFF', 'ACCOUNTANT']
