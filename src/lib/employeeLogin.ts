const INTERNAL_LOGIN_DOMAIN = 'city-painter.local'
export const EMPLOYEE_LOGIN_PLACEHOLDER = '入職年份+分機+編號'
export const EMPLOYEE_LOGIN_ID_PATTERN = /^c\d{6}$/

export function normalizeEmployeeLoginId(value: string | null | undefined): string {
  const raw = (value ?? '').trim().toLowerCase()
  const digits = raw.replace(/^c/, '').replace(/\D/g, '').slice(0, 6)
  return digits ? `c${digits}` : ''
}

export function formatEmployeeLoginInput(value: string | null | undefined): string {
  return normalizeEmployeeLoginId(value)
}

export function isEmployeeLoginId(value: string | null | undefined): boolean {
  return EMPLOYEE_LOGIN_ID_PATTERN.test(normalizeEmployeeLoginId(value))
}

export function employeeLoginEmail(empNo: string): string {
  return `${normalizeEmployeeLoginId(empNo)}@${INTERNAL_LOGIN_DOMAIN}`
}
