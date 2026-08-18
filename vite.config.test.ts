import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { localApiModuleUrl } from './vite.config.ts'

const viteConfigSource = readFileSync(new URL('./vite.config.ts', import.meta.url), 'utf8')

test('本機 API 檔案更新後會產生新的模組網址', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'calendar-local-api-'))
  const handlerPath = path.join(directory, 'handler.js')

  try {
    await writeFile(handlerPath, 'export default () => "old"\n')
    const firstUrl = localApiModuleUrl(handlerPath)

    await writeFile(handlerPath, 'export default () => "new"\n')
    const nextModifiedAt = new Date(Date.now() + 2_000)
    await utimes(handlerPath, nextModifiedAt, nextModifiedAt)
    const secondUrl = localApiModuleUrl(handlerPath)

    assert.notEqual(secondUrl, firstUrl)
    assert.match(secondUrl, /^file:/)
    assert.equal(new URL(secondUrl).searchParams.has('mtime'), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('行事曆導覽頁只由網路優先快取管理', () => {
  assert.match(viteConfigSource, /globPatterns:\s*\['\*\*\/\*\.\{js,css,ico,png,svg,woff2\}'\]/)
  assert.match(viteConfigSource, /navigateFallback:\s*null/)
  assert.match(viteConfigSource, /handler:\s*'NetworkFirst'/)
  assert.doesNotMatch(viteConfigSource, /handler:\s*'StaleWhileRevalidate'/)
})
