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

function scrollFocusedControlIntoModal() {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return
  if (!active.matches('input, textarea, select')) return

  const scrollParent = active.closest<HTMLElement>('.event-editor-body, .modal-body')
  if (!scrollParent) return

  window.setTimeout(() => {
    const fieldRect = active.getBoundingClientRect()
    const parentRect = scrollParent.getBoundingClientRect()
    const margin = 24
    const above = fieldRect.top - parentRect.top - margin
    const below = fieldRect.bottom - parentRect.bottom + margin
    if (above < 0) {
      scrollParent.scrollBy({ top: above, behavior: 'smooth' })
    } else if (below > 0) {
      scrollParent.scrollBy({ top: below, behavior: 'smooth' })
    }
  }, 280)
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
  window.addEventListener('focusin', scrollFocusedControlIntoModal)
  viewport?.addEventListener('resize', updateVisualViewportVars)
  viewport?.addEventListener('scroll', updateVisualViewportVars)
}
