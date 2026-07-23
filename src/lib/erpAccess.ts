const SALES_FORM_FEATURE_KEYS = ['sales-main', 'dashboard-sales-main']
const SALES_SCAN_FEATURE_KEYS = [
  'sales-order-scan',
  'dashboard-order-status',
  ...SALES_FORM_FEATURE_KEYS
]

function hasFeatureActions(
  data: Record<string, unknown> | null,
  featureKeys: string[],
  requiredActions: string[],
): boolean {
  if (!data || data.enabled !== true) return false
  const matrix = data.permissionMatrix
  if (!matrix || typeof matrix !== 'object') return false

  return featureKeys.some((featureKey) => {
    const actions = (matrix as Record<string, unknown>)[featureKey]
    if (!actions || typeof actions !== 'object') return false
    const permission = actions as Record<string, unknown>
    return permission.browse === true && requiredActions.some((action) => permission[action] === true)
  })
}

export function canOpenSalesFormFromAccess(data: Record<string, unknown> | null): boolean {
  return hasFeatureActions(data, SALES_FORM_FEATURE_KEYS, ['update', 'delete'])
}

export function canScanSalesOrderFromAccess(data: Record<string, unknown> | null): boolean {
  return hasFeatureActions(data, SALES_SCAN_FEATURE_KEYS, ['update', 'special'])
}

export function canViewSalesAttachmentsFromAccess(data: Record<string, unknown> | null): boolean {
  return hasFeatureActions(data, ['sales-order-scan', 'dashboard-order-status'], ['update', 'special'])
    || canOpenSalesFormFromAccess(data)
}
