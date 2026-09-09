async function bumpCalendarDataRevision({ db, fieldValue }) {
  // 重送只會多觸發一次重新查詢，不保存事件識別碼或內容於跨員工共用文件。
  await db.collection('calendarDataRevisions').doc('global').set({
    version: fieldValue.increment(1),
    updatedAt: fieldValue.serverTimestamp(),
  }, { merge: true })
}

module.exports = { bumpCalendarDataRevision }
