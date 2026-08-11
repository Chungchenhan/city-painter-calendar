export async function keepUploadFlowAfterLocalStateFailure(
  persistLocalState: () => Promise<unknown>,
  onPersistFailure: (error: unknown) => void,
) {
  try {
    await persistLocalState()
    return true
  } catch (error) {
    onPersistFailure(error)
    return false
  }
}

export async function keepRemoteUploadResult<T>(
  result: T,
  persistLocalState: () => Promise<unknown>,
  onPersistFailure: (error: unknown) => void,
) {
  await keepUploadFlowAfterLocalStateFailure(persistLocalState, onPersistFailure)
  return result
}
