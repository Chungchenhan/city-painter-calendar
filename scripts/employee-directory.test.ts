import assert from 'node:assert/strict'
import { employeeFromDirectory, employeeNicknameTitle } from '../src/lib/employeeDirectory.ts'

const employee = employeeFromDirectory('emp_232216', {
  employeeId: 'emp_232216',
  empNo: 'c232216',
  name: '胡宜萱',
  nickname: '宜萱',
  departmentId: 'advertising',
  departmentName: '廣告部',
  status: 'active'
})

assert.deepEqual(employee, {
  id: 'emp_232216',
  empNo: 'c232216',
  name: '胡宜萱',
  nickname: '宜萱',
  departmentId: 'advertising',
  departmentName: '廣告部',
  status: 'active'
})
assert.equal(employeeNicknameTitle('胡宜萱休假', employee), '宜萱休假')
assert.equal(employeeNicknameTitle('宜萱休假', employee), '宜萱休假')
assert.equal(employeeNicknameTitle('胡宜萱休假', { name: '胡宜萱' }), '胡宜萱休假')
assert.equal(employeeNicknameTitle('胡宜萱休假', { name: '胡', nickname: '宜萱' }), '宜萱休假')

console.log('employee-directory tests passed')
