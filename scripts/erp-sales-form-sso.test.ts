import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const calendarSource = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')

test('事件詳情開啟後立即預熱 ERP 登入接續與目標文件', () => {
  assert.match(calendarSource, /selectedEvent\?\.source === 'erpSalesDelivery' && canOpenSalesForm/u)
  assert.match(calendarSource, /prefetch\.rel = 'prefetch'[\s\S]*prefetch\.as = 'document'[\s\S]*prefetch\.href = erpSalesFormUrl\(salesId\)/u)
  assert.match(calendarSource, /void prepareSalesFormRedirect\(salesId\)\.catch/u)
  assert.doesNotMatch(calendarSource, /setTimeout\([\s\S]{0,100}prepareSalesFormRedirect\(salesId\)/u)
  assert.match(calendarSource, /preconnect\.href = erpOrigin\(\)/u)
})

test('點擊銷貨單共用該單號已預熱的單次票據並可直接開啟目標網址', () => {
  assert.match(calendarSource, /salesFormRedirectPrefetchesRef\.current\.get\(salesId\)/u)
  assert.match(calendarSource, /Date\.now\(\) - prepared\.createdAt < SALES_FORM_REDIRECT_REUSE_MS/u)
  assert.match(calendarSource, /SALES_FORM_POPUP_NAME = 'city_painter_sales_form'/u)
  assert.match(calendarSource, /SALES_FORM_POPUP_FEATURES = \[[\s\S]*'scrollbars=yes',[\s\S]*\]\.join\(','\)/u)
  assert.match(calendarSource, /window\.open\(\s*preparedUrl \|\| 'about:blank',\s*SALES_FORM_POPUP_NAME,\s*SALES_FORM_POPUP_FEATURES,/u)
  assert.match(calendarSource, /const redirectUrl = preparedUrl \|\| await prepareSalesFormRedirect\(salesId\)/u)
  assert.match(calendarSource, /body\.textContent = '正在開啟銷貨單…'/u)
})

test('預熱票據在九十秒後不再重用', () => {
  assert.match(calendarSource, /SALES_FORM_REDIRECT_REUSE_MS = 90_000/u)
  assert.match(calendarSource, /now - cachedEntry\.createdAt >= SALES_FORM_REDIRECT_REUSE_MS/u)
  assert.match(calendarSource, /new Map<string, SalesFormRedirectPrefetch>/u)
})

test('拖曳 ERP 配送事件會透過受保護同步端點更新銷售單', () => {
  assert.match(calendarSource, /if \(sourceEvent\.source === 'erpSalesDelivery'\) \{\s*await syncSalesDeliveryEventFields\(\s*sourceEvent,\s*movedEvent,/u)
})
