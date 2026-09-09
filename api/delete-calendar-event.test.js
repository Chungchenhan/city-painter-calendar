import assert from 'node:assert/strict'
import test from 'node:test'
import { canDeleteEvent, isProtectedErpSalesDeliveryPrimaryEvent } from './delete-calendar-event.js'

test('ERP 主事件缺少角色欄位時禁止刪除', () => {
  assert.equal(isProtectedErpSalesDeliveryPrimaryEvent({
    source: 'erpSalesDelivery',
    sourceId: 'sales-1',
  }), true)
  assert.equal(isProtectedErpSalesDeliveryPrimaryEvent({ source: 'erpSalesDelivery' }), true)
})

test('ERP 主事件即使帶有 parent 欄位也不能繞過刪除保護', () => {
  assert.equal(isProtectedErpSalesDeliveryPrimaryEvent({
    source: 'erpSalesDelivery',
    sourceId: 'sales-1',
    sourceParentEventId: 'unexpected-parent',
  }), true)
})

test('ERP 附屬事件允許進入既有權限刪除流程', () => {
  assert.equal(isProtectedErpSalesDeliveryPrimaryEvent({
    source: 'erpSalesDelivery',
    sourceId: 'sales-1',
    sourceEventRole: 'related',
    sourceParentEventId: 'erpSalesDelivery_sales-1',
  }), false)
})

test('一般事件不受 ERP 主事件刪除保護影響', () => {
  assert.equal(isProtectedErpSalesDeliveryPrimaryEvent({ source: 'manual' }), false)
})

function permissionDb(employeeId, role = 'employee') {
  return { collection: (name) => ({ doc: () => ({ get: async () => ({
    exists: true, id: employeeId,
    data: () => name === 'userRoles' ? { employeeId, role } : { departmentId: 'advertising', departmentName: '廣告部' },
  }) }), get: async () => ({ docs: [] }) }) }
}

test('限制員工不能透過同部門、指派、建立者或管理員身分刪除 ERP 附屬事件', async () => {
  for (const employeeId of ['emp_085101', 'emp_239215']) {
    for (const role of ['employee', 'admin']) {
      assert.equal(await canDeleteEvent(permissionDb(employeeId, role), { uid: 'user' }, {
        source: 'erpSalesDelivery', sourceEventRole: 'related', sourceParentEventId: 'main',
        sourceEventKind: 'construction-visit', createdBy: 'user', departmentId: 'advertising', assigneeIds: [employeeId],
      }, 'visit'), false)
      assert.equal(await canDeleteEvent(permissionDb(employeeId, role), { uid: 'user' }, {
        source: 'erpSalesDelivery', sourceEventRole: 'related', sourceParentEventId: 'main', sourceEventKind: 'teardown', departmentId: 'advertising',
      }, 'teardown'), false)
    }
  }
})
test('一般事件及未受限人員沿用既有刪除權限', async () => {
  assert.equal(await canDeleteEvent(permissionDb('emp_239215'), { uid: 'user' }, { source: 'manual', createdBy: 'user' }, 'manual'), true)
  assert.equal(await canDeleteEvent(permissionDb('other'), { uid: 'user' }, { source: 'erpSalesDelivery', sourceEventRole: 'related', sourceParentEventId: 'main', departmentId: 'advertising' }, 'visit'), true)
  assert.equal(await canDeleteEvent(permissionDb('emp_239215'), null, { source: 'manual' }, 'manual'), false)
})
