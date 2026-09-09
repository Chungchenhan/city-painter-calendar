const RESTRICTED_EMPLOYEE_IDS = new Set(['emp_085101', 'emp_239215'])

export function isErpEventEditRestricted(employeeId) {
  return RESTRICTED_EMPLOYEE_IDS.has(employeeId)
}

export function canEditOrCopyErpEvent(employeeId, event) {
  return event?.source !== 'erpSalesDelivery' || (
    Boolean(employeeId) && !isErpEventEditRestricted(employeeId)
  )
}
