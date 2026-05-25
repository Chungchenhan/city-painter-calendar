let updateFrame = 0
let lastHeight = ''
let lastOffsetTop = ''
let lastKeyboardInset = ''

function applyVisualViewportVars() {
  const viewport = window.visualViewport
  const height = Math.round(viewport?.height ?? window.innerHeight)
  const offsetTop = Math.round(viewport?.offsetTop ?? 0)
  const keyboardInset = Math.max(0, Math.round(window.innerHeight - height - offsetTop))
  const heightValue = `${height}px`
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
