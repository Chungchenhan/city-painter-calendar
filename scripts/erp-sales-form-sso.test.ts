import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const calendarSource = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')

test('事件詳情開啟後才預熱 ERP 登入接續，不增加首頁請求', () => {
  assert.match(calendarSource, /selectedEvent\?\.source === 'erpSalesDelivery' && canOpenSalesForm/u)
  assert.match(calendarSource, /window\.setTimeout\(\(\) => \{\s*void prepareSalesFormRedirect\(salesId\)/u)
  assert.match(calendarSource, /preconnect\.href = erpOrigin\(\)/u)
})

test('點擊銷貨單共用已預熱的單次票據並可直接開啟目標網址', () => {
  assert.match(calendarSource, /const preparedUrl = prepared\?\.salesId === salesId && Date\.now\(\) - prepared\.createdAt < 90_000/u)
  assert.match(calendarSource, /window\.open\(preparedUrl \|\| 'about:blank', '_blank'\)/u)
  assert.match(calendarSource, /const redirectUrl = preparedUrl \|\| await prepareSalesFormRedirect\(salesId\)/u)
})

test('預熱票據在九十秒後不再重用', () => {
  assert.match(calendarSource, /Date\.now\(\) - cached\.createdAt < 90_000/u)
})

test('拖曳 ERP 配送事件會透過受保護同步端點更新銷售單', () => {
  assert.match(calendarSource, /if \(sourceEvent\.source === 'erpSalesDelivery'\) \{\s*await syncSalesDeliveryEventFields\(\s*sourceEvent,\s*movedEvent,/u)
})
