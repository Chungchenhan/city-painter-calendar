import type { Employee } from '../types'

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

export function employeeFromDirectory(id: string, data: Record<string, unknown>): Employee {
  const empNo = text(data.empNo)
  const nickname = text(data.nickname)
  const name = text(data.name) || nickname || empNo || id
  const departmentId = text(data.departmentId)
  const departmentName = text(data.departmentName)
  const status = text(data.status) || 'active'

  return {
    id,
    ...(empNo ? { empNo } : {}),
    name,
    ...(nickname ? { nickname } : {}),
    ...(departmentId ? { departmentId } : {}),
    ...(departmentName ? { departmentName } : {}),
    status
  }
}

export function employeeNicknameTitle(title: string, employee?: Pick<Employee, 'name' | 'nickname'>) {
  const nickname = employee?.nickname?.trim()
  const name = employee?.name?.trim()
  if (!nickname || !name || title.startsWith(nickname) || !title.startsWith(name)) return title

  const remainder = title.slice(name.length)
  return `${nickname}${remainder.startsWith(nickname) ? remainder.slice(nickname.length) : remainder}`
}
