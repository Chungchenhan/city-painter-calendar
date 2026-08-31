import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')

assert.match(
  source,
  /SALES_ATTACHMENT_URL_REFRESH_INTERVAL_MS = 4 \* 60 \* 1000/,
  '行事曆的銷貨附件安全連結必須在 10 分鐘到期前更新',
)
assert.match(
  source,
  /queryKey: \['sales-center-attachments'[\s\S]*refetchInterval: SALES_ATTACHMENT_URL_REFRESH_INTERVAL_MS,[\s\S]*refetchOnWindowFocus: 'always'/,
  '銷貨附件中心必須定期更新，並在回到前景時立即重新取得連結',
)

console.log('行事曆銷貨附件連結更新測試通過。')
