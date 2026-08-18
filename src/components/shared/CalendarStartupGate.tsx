import { useEffect } from 'react'

const STARTUP_ANIMATION_MS = 2_900

export default function CalendarStartupGate() {
  useEffect(() => {
    const loader = document.getElementById('calendar-startup-loader')
    const root = document.getElementById('root')
    if (!loader || !root || loader.dataset.revealing === 'true') return

    let cancelled = false

    const reveal = () => {
      if (cancelled || loader.dataset.revealing === 'true') return
      loader.dataset.revealing = 'true'

      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (cancelled) return
          root.removeAttribute('aria-hidden')
          root.removeAttribute('inert')
          loader.classList.add('cp-initial-loader--complete')
          window.setTimeout(() => loader.remove(), 240)
        })
      })
    }

    const startedAt = Number(loader.dataset.startedAt || 0)
    const remainingAnimationMs = Math.max(0, STARTUP_ANIMATION_MS - (performance.now() - startedAt))
    const revealTimer = window.setTimeout(reveal, remainingAnimationMs)

    return () => {
      cancelled = true
      window.clearTimeout(revealTimer)
    }
  }, [])

  return null
}
