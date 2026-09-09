import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { calendarAttachmentLinks, lineImageSignature, validLineImageSignature } from './upload-drive.js'
process.env.LINE_IMAGE_SIGNING_SECRET = 'test-only-calendar-secret'
const actor = { uid: 'user1', employeeId: 'emp1', role: 'employee', employee: {} }
const fileId = 'drive-file-12345'
const db = (event, comments = []) => ({ collection: () => ({ doc: () => ({
  get: async () => ({ exists: Boolean(event), id: 'event1', data: () => event }),
  collection: () => ({ get: async () => ({ docs: comments.map((item) => ({ data: () => item })) }) }),
}) }) })

test('簽名拒絕過期、永久舊簽名及任何欄位竄改', () => {
  const now = 2000000000
  const expires = now + 600
  const signature = lineImageSignature(fileId, 'original', expires)
  assert.equal(validLineImageSignature(fileId, 'original', expires, signature, now), true)
  for (const args of [[fileId, 'original', now, signature], [fileId, 'preview', expires, signature], ['other-file', 'original', expires, signature], [fileId, 'original', expires + 1, signature], [fileId, 'original', NaN, signature], [fileId, 'unknown', expires, signature], [fileId, 'original', expires, `${signature}00`]]) {
    assert.equal(validLineImageSignature(...args, now), false)
  }
})
test('合法員工只能重簽自己可見事件及留言中的附件', async () => {
  const event = { assigneeIds: ['emp1'], attachments: [{ path: fileId }] }
  const result = await calendarAttachmentLinks(db(event), actor, { eventId: 'event1', fileIds: [fileId] })
  const url = new URL(result.links[0].downloadUrl)
  assert.equal(validLineImageSignature(fileId, 'download', Number(url.searchParams.get('expires')), url.searchParams.get('signature')), true)
  const commentResult = await calendarAttachmentLinks(db({ assigneeIds: ['emp1'] }, [{ attachments: [{ path: fileId }] }]), actor, { eventId: 'event1', fileIds: [fileId] })
  assert.equal(commentResult.links[0].fileId, fileId)
  await assert.rejects(calendarAttachmentLinks(db({ ...event, assigneeIds: ['emp2'] }), actor, { eventId: 'event1', fileIds: [fileId] }), { status: 403 })
  await assert.rejects(calendarAttachmentLinks(db(event), actor, { eventId: 'event1', fileIds: ['other-file-12345'] }), { status: 403 })
})
test('新上傳不得建立 anyone 權限且端點位於員工驗證之後', () => {
  for (const name of ['api/upload-drive.js', 'functions/backgroundAttachmentWorker.js']) {
    const source = fs.readFileSync(name, 'utf8')
    assert.doesNotMatch(source, /permissions\.create/)
  }
  const source = fs.readFileSync('api/upload-drive.js', 'utf8')
  assert.ok(source.indexOf('const actor = await authenticateEmployee(req)') < source.indexOf("body.action === 'calendar-attachment-links'"))
})

test('公開繼承資料夾拒絕新上傳，分頁權限也要檢查', async () => {
  const { assertPrivateDriveFolder } = await import('./upload-drive.js')
  await assertPrivateDriveFolder({ permissions: { list: async () => ({ data: { permissions: [{ type: 'user' }] } }) } }, 'folder1')
  let calls = 0
  await assert.rejects(assertPrivateDriveFolder({ permissions: { list: async () => ({ data: ++calls === 1
    ? { permissions: [{ type: 'user' }], nextPageToken: 'page2' } : { permissions: [{ type: 'anyone' }] } }) } }, 'folder1'), /公開繼承/)
  assert.equal(calls, 2)
})

test('授權下載由伺服器Drive代理，錯誤或過期連結不接觸Drive', async () => {
  const { default: handler } = await import('./upload-drive.js')
  const { google } = await import('googleapis')
  const originalDrive = google.drive
  const keys = ['GOOGLE_DRIVE_OAUTH_CLIENT_ID', 'GOOGLE_DRIVE_OAUTH_CLIENT_SECRET', 'GOOGLE_DRIVE_OAUTH_REFRESH_TOKEN']
  const saved = keys.map((key) => process.env[key])
  for (const key of keys) process.env[key] = 'test-only-placeholder'
  let reads = 0
  google.drive = () => ({ files: { get: async ({ alt }) => { reads++; return { data: alt === 'media' ? Buffer.from('test-document') : { mimeType: 'application/pdf' } } } } })
  const response = () => ({ headers: {}, status(code) { this.statusCode = code; return this }, setHeader(name, value) { this.headers[name] = value }, json(body) { this.body = body }, end(body) { this.body = body } })
  try {
    const expires = Math.floor(Date.now() / 1000) + 600
    const signature = lineImageSignature(fileId, 'download', expires)
    const res = response()
    await handler({ method: 'GET', query: { fileId, variant: 'download', expires: String(expires), signature } }, res)
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.toString(), 'test-document')
    assert.equal(res.headers['Cache-Control'], 'private, no-store')
    assert.equal(res.headers['Content-Disposition'], 'attachment')
    for (const query of [{ fileId, variant: 'download', expires: String(expires), signature: '0'.repeat(64) }, { fileId, variant: 'download', expires: '1', signature: lineImageSignature(fileId, 'download', 1) }]) {
      const rejected = response()
      await handler({ method: 'GET', query }, rejected)
      assert.equal(rejected.statusCode, 403)
    }
    assert.equal(reads, 2)
  } finally {
    google.drive = originalDrive
    keys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
  }
})

test('OAuth無法讀父目錄時使用受授權SA完整驗證，不能略過公開或讀取錯誤', async () => {
  const { assertPrivateDriveFolder } = await import('./upload-drive.js')
  const oauth = { permissions: { list: async () => { throw Object.assign(new Error('not visible'), { code: 404 }) } } }
  const privateReader = () => ({ permissions: { list: async () => ({ data: { permissions: [{ type: 'user' }] } }) } })
  await assertPrivateDriveFolder(oauth, 'folder1', privateReader)
  await assert.rejects(assertPrivateDriveFolder(oauth, 'folder1', () => ({ permissions: { list: async () => ({ data: { permissions: [{ type: 'anyone' }] } }) } })), /公開繼承/)
  await assert.rejects(assertPrivateDriveFolder(oauth, 'folder1', () => oauth), /not visible/)
})
