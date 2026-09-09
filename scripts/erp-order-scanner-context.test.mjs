import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/components/ErpOrderScanner.tsx', import.meta.url), 'utf8')

assert.match(source, /const \[scanSessionId\] = useState\(createScanIdentifier\)/)
assert.match(source, /clientAttemptId: createScanIdentifier\(\),\s*scanSessionId,\s*inputMode,\s*qrPayloadType: qrPayloadType\(rawValue\)/s)
assert.match(source, /action: 'scan-order-status',\s*salesId,\s*clientAttemptId: context\.clientAttemptId,\s*scanSessionId: context\.scanSessionId,\s*inputMode: context\.inputMode,\s*qrPayloadType: context\.qrPayloadType/s)
assert.match(source, /processSalesId\(rawValue, 'camera'\)/)
assert.match(source, /processSalesId\(decodedText, 'photo'\)/)
assert.doesNotMatch(source, /raw(?:Qr|QR|Payload|Value):\s*(?:rawValue|decodedText)/)

console.log('ERP 銷貨單 QR 掃描上下文測試通過')
