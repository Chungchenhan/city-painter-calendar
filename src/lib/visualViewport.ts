let updateFrame = 0
let lastHeight = ''
let lastOffsetTop = ''
let lastKeyboardInset = ''

function isStandalonePwa() {
  return window.matchMedia('(display-mode: standalone)').matches ||
    ('standalone' in window.navigator && Boolean(window.navigator.standalone))
}

function applyVisualViewportVars() {
  const viewport = window.visualViewport
  const standalonePwa = isStandalonePwa()
  const viewportHeight = Math.round(viewport?.height ?? window.innerHeight)
  const height = standalonePwa ? window.innerHeight : viewportHeight
  const offsetTop = standalonePwa ? 0 : Math.round(viewport?.offsetTop ?? 0)
  const keyboardInset = Math.max(0, Math.round(window.innerHeight - viewportHeight - offsetTop))
  const heightValue = `${Math.round(height)}px`
  const offsetTopValue = `${offsetTop}px`
  const keyboardInsetValue = `${keyboardInset}px`

  if (heightValue !== lastHeight) {
    document.documentElement.style.setProperty('--app-visual-viewport-height', heightValue)
    lastHeight = heightValue
  }
  if (offsetTopValue !== lastOffsetTop) {
    document.documentElement.style.setProperty('--app-visual-viewport-offset-top', offsetTopValue)
    lastOffsetTop = offsetTopValue
  }
  if (keyboardInsetValue !== lastKeyboardInset) {
    document.documentElement.style.setProperty('--app-keyboard-inset', keyboardInsetValue)
    lastKeyboardInset = keyboardInsetValue
  }
  document.documentElement.classList.toggle('pwa-standalone', standalonePwa)
  document.documentElement.classList.toggle('keyboard-open', keyboardInset > 80)
}

function updateVisualViewportVars() {
  if (updateFrame) window.cancelAnimationFrame(updateFrame)
  updateFrame = window.requestAnimationFrame(() => {
    updateFrame = 0
    applyVisualViewportVars()
  })
}

export function setupVisualViewportVars() {
  updateVisualViewportVars()

  const viewport = window.visualViewport
  window.addEventListener('resize', updateVisualViewportVars)
  window.addEventListener('orientationchange', updateVisualViewportVars)
  viewport?.addEventListener('resize', updateVisualViewportVars)
  viewport?.addEventListener('scroll', updateVisualViewportVars)
}
