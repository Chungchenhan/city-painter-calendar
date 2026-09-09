import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { normalizeSalesManagerChats } from '../src/lib/lineManagerChat.ts'

const calendarSource = readFileSync(new URL('../src/pages/CalendarPage.tsx', import.meta.url), 'utf8')
const stylesSource = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

test('只接受 LINE Manager 正式聊天室連結並保留聊天室名稱', () => {
  assert.deepEqual(normalizeSalesManagerChats([{ name: ' 0970604360 林苡彤 ', url: 'https://chat.line.biz/U583a5dcc6f6b1834ef1b71a385a0f703/chat/U1234567890abcdef1234567890abcdef' }, { name: '偽造', url: 'https://example.com/chat' }]), [{
    name: '0970604360 林苡彤',
    url: 'https://chat.line.biz/U583a5dcc6f6b1834ef1b71a385a0f703/chat/U1234567890abcdef1234567890abcdef',
  }])
})

test('事件詳情桌機開啟聊天室，手機直接交由 LINE 官方帳號 App 接手', () => {
  assert.match(calendarSource, /productionLineStatus\?\.bound[\s\S]{0,80}\? '官方 LINE：'[\s\S]{0,180}productionLineBindingDescription\(productionLineStatus\)/u)
  assert.match(calendarSource, /map\(\(chat, index\)[\s\S]{0,160}index > 0 && ' · '/u)
  assert.match(calendarSource, /href=\{chat\.url\}[\s\S]*target="_blank"/u)
  assert.match(calendarSource, /matchMedia\?\.\('\(max-width: 768px\)'\)\.matches/u)
  assert.match(calendarSource, /preventDefault\(\)[\s\S]*window\.location\.assign\(chatUrl\)/u)
  assert.doesNotMatch(calendarSource, /copyTextToClipboard|已複製聊天室名稱/u)
  assert.match(calendarSource, /handleManagerChatClick\(event, chat\.url\)/u)
  assert.match(stylesSource, /@media \(max-width: 768px\)[\s\S]*\.event-detail-manager-chat-link[\s\S]*min-height: 44px/u)
})
