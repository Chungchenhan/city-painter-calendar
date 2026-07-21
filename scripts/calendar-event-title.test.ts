import assert from 'node:assert/strict'
import { composeEditableEventTitle } from '../src/lib/calendarEventTitle.ts'

assert.equal(composeEditableEventTitle('', '興東里 活動'), '興東里 活動')
assert.equal(composeEditableEventTitle('📦', '興東里'), '📦 興東里')
assert.equal(composeEditableEventTitle('📦', '興東里 '), '📦 興東里 ')
assert.equal(composeEditableEventTitle('📦', '興東里  活動'), '📦 興東里  活動')
assert.equal(composeEditableEventTitle('📦', ''), '📦')

console.log('calendar event title tests passed')
