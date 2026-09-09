import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
const sourceUrl = new URL('../src/lib/combinedDelivery.ts', import.meta.url)
const moduleSource = stripTypeScriptTypes(readFileSync(sourceUrl, 'utf8')).replace("'./deliveryEventGrouping'", JSON.stringify(new URL('../src/lib/deliveryEventGrouping.ts', import.meta.url).href))
const { combinedDeliveryCandidates, combinedDeliveryOrders, combinedDeliveryUnavailable } = await import(`data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`)
import type { CalendarEvent } from '../src/types/index.ts'
import type { SalesOperationalStatus } from '../src/lib/salesOperationalStatus.ts'
const source = { id: 'e1', source: 'erpSalesDelivery', sourceId: 's1', sourceSalesNo: '001', sourceCustomerCode: 'C1', sourceShippingMethod: '外送', location: '地址1', date: '2026-09-08', endDate: '2026-09-08', startTime: '14:00', endTime: '15:00', calendarId: 'c1' } as CalendarEvent
const second = { ...source, id: 'e2', sourceId: 's2', sourceSalesNo: '002' }
const status = { canCompleteOrder: true, shippingMethod: '外送', orderStatus: '即將配送' } as SalesOperationalStatus
assert.deepEqual(combinedDeliveryCandidates(source,[second,{...second,id:'duplicate'}, {...second,id:'other',sourceId:'s3',location:'其他地址'}, {...second,id:'foreign',sourceId:'s4',sourceCustomerCode:'C2'}]).map(row=>row.id), ['e1','e2'])
assert.equal(combinedDeliveryUnavailable(second, {...status,canCompleteOrder:false}), '沒有配達回報權限')
assert.equal(combinedDeliveryUnavailable({...second,done:true},status), '已配達')
assert.throws(()=>combinedDeliveryOrders([source,second],{e1:status}), /正在確認訂單/)
assert.throws(()=>combinedDeliveryOrders([source],{e1:{...status,orderStatus:'已送達'}}), /已配達/)
assert.throws(()=>combinedDeliveryOrders([source],{e1:{...status,shippingMethod:'施工'}}), /僅外送/)
assert.deepEqual(combinedDeliveryOrders([source,second],{e1:status,e2:status}),[
  {eventId:'e1',salesId:'s1',expectedShippingMethod:'外送',expectedOrderStatus:'即將配送'},
  {eventId:'e2',salesId:'s2',expectedShippingMethod:'外送',expectedOrderStatus:'即將配送'},
])
console.log('combined delivery: candidate scope, permission, completion, shipping and exact snapshots passed')
