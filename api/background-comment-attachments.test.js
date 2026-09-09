import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveBackgroundCommentAttachments } from './upload-drive.js'

const actor = { uid: 'employee-uid', employeeId: 'employee-id', employee: { name: '測試員工' } }
const id = 'drive-file-12345'
const file = {
  id, name: '文件.pdf', mimeType: 'application/pdf', size: '123',
  appProperties: {
    calendarUploaderUid: actor.uid,
    calendarUploadKind: 'comment',
    calendarEventId: 'event-id',
    calendarCommentId: 'comment-id',
  },
}
const resolve = (value, attachments = [{ path: id }]) => resolveBackgroundCommentAttachments(
  { files: { get: async () => ({ data: value }) } }, actor, 'event-id', 'comment-id', attachments,
)

test('混合留言附件只採用伺服器中繼資料，忽略偽造名稱與網址', async () => {
  const [attachment] = await resolve(file, [{ path: id, url: 'https://untrusted.invalid', name: '偽造', type: 'image/png' }])
  assert.equal(attachment.name, file.name)
  assert.equal(attachment.type, 'application/pdf')
  assert.equal(attachment.url, `https://drive.google.com/file/d/${id}/view`)
  assert.equal(attachment.size, 123)
})

test('混合留言不能挪用另一上傳者、事件或留言的檔案', async () => {
  for (const key of ['calendarUploaderUid', 'calendarEventId', 'calendarCommentId', 'calendarUploadKind']) {
    await assert.rejects(resolve({ ...file, appProperties: { ...file.appProperties, [key]: 'other' } }), (error) => error.status === 403)
  }
  await assert.rejects(resolve({ ...file, trashed: true }), (error) => error.status === 403)
})

test('重複、無效或過量附件在呼叫 Drive 前拒絕', async () => {
  for (const attachments of [[{ path: '../invalid' }], [{ path: id }, { path: id }], Array.from({ length: 11 }, (_, index) => ({ path: `${id}-${index}` }))]) {
    await assert.rejects(resolve(file, attachments), (error) => error.status === 400)
  }
  assert.deepEqual(await resolve(file, []), [])
})

function commentDb(initialComment) {
  let stored = initialComment
  const commentRef = { id: 'comment-id', path: 'calendarEvents/event-id/comments/comment-id' }
  const db = {
    collection: () => ({ doc: () => ({
      get: async () => ({ exists: true, id: 'event-id', data: () => ({ assigneeIds: [actor.employeeId] }) }),
      collection: () => ({ doc: () => commentRef }),
    }) }),
    runTransaction: async (run) => run({
      get: async () => ({ exists: Boolean(stored), data: () => stored }),
      create: (_ref, value) => { stored = value },
      update: (_ref, patch) => { stored = { ...stored, ...patch } },
    }),
  }
  return { db, read: () => stored }
}

test('無待上傳照片的純文字留言合法，空留言拒絕', async () => {
  const { createBackgroundComment } = await import('./upload-drive.js')
  const state = commentDb()
  const body = { eventId: 'event-id', commentId: 'comment-id', text: '測試文字', pendingAttachmentCount: 0 }
  await createBackgroundComment(state.db, actor, body)
  await createBackgroundComment(state.db, actor, body)
  assert.equal(state.read().pendingAttachmentCount, 0)
  assert.equal(state.read().text, '測試文字')
  await assert.rejects(createBackgroundComment(state.db, actor, { ...body, text: '' }), (error) => error.status === 400)
  await assert.rejects(createBackgroundComment(state.db, actor, { ...body, pendingAttachmentCount: -1 }), (error) => error.status === 400)
})

test('本機留言附件由伺服器核對owner並冪等扣減待上傳數', async () => {
  const { commitDevelopmentCommentAttachment } = await import('./upload-drive.js')
  const state = commentDb({ authorUid: actor.uid, authorEmployeeId: actor.employeeId, attachments: [], pendingAttachmentCount: 1 })
  const drive = { files: { get: async () => ({ data: file }) } }
  const body = { eventId: 'event-id', commentId: 'comment-id', fileId: id }
  await commitDevelopmentCommentAttachment(state.db, actor, body, drive)
  await commitDevelopmentCommentAttachment(state.db, actor, body, drive)
  assert.equal(state.read().attachments.length, 1)
  assert.equal(state.read().pendingAttachmentCount, 0)
  assert.equal(state.read().attachments[0].name, file.name)
  const otherAuthor = commentDb({ authorUid: 'other', authorEmployeeId: actor.employeeId, attachments: [], pendingAttachmentCount: 1 })
  await assert.rejects(commitDevelopmentCommentAttachment(otherAuthor.db, actor, body, drive), (error) => error.status === 403)
  const noPending = commentDb({ authorUid: actor.uid, authorEmployeeId: actor.employeeId, attachments: [], pendingAttachmentCount: 0 })
  await assert.rejects(commitDevelopmentCommentAttachment(noPending.db, actor, body, drive), (error) => error.status === 409)
  await assert.rejects(commitDevelopmentCommentAttachment(state.db, actor, body, { files: { get: async () => ({ data: { ...file, appProperties: { ...file.appProperties, calendarUploaderUid: 'other' } } }) } }), (error) => error.status === 403)
})
