import { onIdTokenChanged } from 'firebase/auth'
import { auth, getAppCheckHeaders } from './firebase'

type WidgetBridge = { postMessage: (message: Record<string, string>) => void }

export function setupNativeWidgetAuth(): void {
  const bridge = (window as Window & { webkit?: { messageHandlers?: { cityPainterWidgetAuth?: WidgetBridge } } }).webkit?.messageHandlers?.cityPainterWidgetAuth
  if (!bridge || window.location.origin !== 'https://sch.city-painter.com' || window.top !== window) return
  let generation = 0
  const sync = async () => {
    const current = ++generation
    await auth.authStateReady()
    if (current !== generation) return
    const user = auth.currentUser
    if (!user) { bridge.postMessage({ type: 'logout' }); return }
    try {
      const [idToken, headers] = await Promise.all([user.getIdToken(), getAppCheckHeaders(true)])
      if (current !== generation || auth.currentUser?.uid !== user.uid) return
      bridge.postMessage({ type: 'session', idToken, appCheckToken: headers['X-Firebase-AppCheck'] })
    } catch {
      // 小工具驗證失敗不阻斷主行事曆，下一次前景或 token 更新時重試。
    }
  }
  onIdTokenChanged(auth, () => { void sync() })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void sync() })
}
