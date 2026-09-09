export function createForegroundRequest<T>({
  load,
  onSuccess,
  onError,
}: {
  load: (signal: AbortSignal) => Promise<T>
  onSuccess: (value: T) => void
  onError: (error: unknown) => void
}) {
  let disposed = false
  let current: { controller: AbortController, promise: Promise<void> } | null = null

  const cancel = () => {
    const pending = current
    current = null
    pending?.controller.abort()
  }

  return {
    run(): Promise<void> {
      if (disposed) return Promise.resolve()
      if (current) return current.promise
      const controller = new AbortController()
      const ownsRequest = () => !disposed && current?.controller === controller && !controller.signal.aborted
      const promise = Promise.resolve()
        .then(() => {
          controller.signal.throwIfAborted()
          return load(controller.signal)
        })
        .then((value) => {
          if (ownsRequest()) onSuccess(value)
        })
        .catch((error: unknown) => {
          if (ownsRequest()) onError(error)
        })
        .finally(() => {
          // 被取消的舊請求即使較晚結束，也不能清除前景新請求的擁有權。
          if (current?.controller === controller) current = null
        })
      current = { controller, promise }
      return promise
    },
    cancel,
    dispose() {
      disposed = true
      cancel()
    },
  }
}
