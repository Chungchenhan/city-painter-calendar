export function shouldUseCalendarCloudUpload(development: boolean, flag: unknown, existingJobId?: string) {
  return Boolean(existingJobId) || !development || flag === 'true'
}

export function createCloudSafeBatchNotice(rows: readonly { id: string, cloudSafe: boolean }[]) {
  const expected = new Set(rows.map((row) => row.id))
  const safe = new Set(rows.filter((row) => row.cloudSafe).map((row) => row.id))
  let notified = safe.size === expected.size
  return (id: string) => {
    if (!expected.has(id)) return false
    safe.add(id)
    if (notified || safe.size !== expected.size) return false
    notified = true
    return true
  }
}
