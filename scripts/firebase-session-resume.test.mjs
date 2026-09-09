import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const [firebaseSource, mainSource, hookSource, calendarSource, statusSource, scannerSource] = await Promise.all([
  readFile(new URL('../src/lib/firebase.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/hooks/useSalesOperationalStatus.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/lib/salesOperationalStatus.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/ErpOrderScanner.tsx', import.meta.url), 'utf8'),
])

assert.match(firebaseSource, /export async function getFirebaseIdToken\(user: User\)/)
assert.match(firebaseSource, /auth\/network-request-failed/)
assert.doesNotMatch(firebaseSource, /getIdToken\(true\)/)
assert.doesNotMatch(mainSource, /setupFirebaseSessionRefresh/)
assert.doesNotMatch(hookSource, /refreshFirebaseSession|revalidate\(true\)/)
assert.match(hookSource, /addEventListener\('online', handleReconnect\)/)
assert.match(calendarSource, /refetchOnReconnect: 'always'/)
assert.match(calendarSource, /setSalesFormOpenError\(firebaseRequestErrorMessage/)
assert.match(calendarSource, /salesCenterAttachmentsQuery\.error,[\s\S]*附件中心讀取失敗/)
assert.match(calendarSource, /getFirebaseIdToken\(user\)/)
assert.match(statusSource, /getFirebaseIdToken\(user\)/)
assert.match(scannerSource, /getFirebaseIdToken\(currentUser\)/)

console.log('Firebase 前景恢復與驗證錯誤處理回歸測試通過')
