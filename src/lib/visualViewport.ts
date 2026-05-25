function updateVisualViewportVars() {
  const viewport = window.visualViewport
  const height = viewport?.height ?? window.innerHeight
  const offsetTop = viewport?.offsetTop ?? 0
  const keyboardInset = Math.max(0, window.innerHeight - height - offsetTop)

  document.documentElement.style.setProperty('--app-visual-viewport-height', `${height}px`)
  document.documentElement.style.setProperty('--app-visual-viewport-offset-top', `${offsetTop}px`)
  document.documentElement.style.setProperty('--app-keyboard-inset', `${keyboardInset}px`)
  document.documentElement.classList.toggle('keyboard-open', keyboardInset > 80)
}

export function setupVisualViewportVars() {
  updateVisualViewportVars()

  const viewport = window.visualViewport
  window.addEventListener('resize', updateVisualViewportVars)
  window.addEventListener('orientationchange', updateVisualViewportVars)
  viewport?.addEventListener('resize', updateVisualViewportVars)
  viewport?.addEventListener('scroll', updateVisualViewportVars)
}
