let updateFrame = 0
let lastHeight = ''
let lastOffsetTop = ''
let lastKeyboardInset = ''

export function visualViewportKeyboardInset(innerHeight: number, viewportHeight: number, offsetTop: number) {
  return Math.max(0, Math.round(innerHeight - viewportHeight - offsetTop))
}

export function isVisualViewportReducedByKeyboard() {
  const viewport = window.visualViewport
  if (!viewport) return false
  return visualViewportKeyboardInset(window.innerHeight, viewport.height, viewport.offsetTop) > 80
}

function isTextKeyboardControl(element: Element | null) {
  if (element instanceof HTMLTextAreaElement) return true
  if (element instanceof HTMLElement && element.isContentEditable) return true
  if (!(element instanceof HTMLInputElement)) return false
  return ['text', 'search', 'email', 'tel', 'url', 'password', 'number'].includes(element.type)
}

function applyVisualViewportVars() {
  const viewport = window.visualViewport
  const height = Math.round(viewport?.height ?? window.innerHeight)
  const offsetTop = Math.round(viewport?.offsetTop ?? 0)
  const keyboardInset = visualViewportKeyboardInset(window.innerHeight, height, offsetTop)
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
  document.documentElement.classList.toggle(
    'keyboard-open',
    keyboardInset > 80 && isTextKeyboardControl(document.activeElement),
  )
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

function settleVisualViewportVars() {
  updateVisualViewportVars()
  window.setTimeout(updateVisualViewportVars, 120)
  window.setTimeout(updateVisualViewportVars, 360)
}

export function dismissActiveKeyboard() {
  const active = document.activeElement
  if (active instanceof HTMLElement) active.blur()
  settleVisualViewportVars()
}

export function setupVisualViewportVars() {
  updateVisualViewportVars()

  const viewport = window.visualViewport
  window.addEventListener('resize', updateVisualViewportVars)
  window.addEventListener('orientationchange', updateVisualViewportVars)
  window.addEventListener('focusin', (event) => {
    scrollFocusedControlIntoModal()
    if (isTextKeyboardControl(event.target as Element | null)) settleVisualViewportVars()
  })
  window.addEventListener('focusout', settleVisualViewportVars)
  window.addEventListener('pageshow', settleVisualViewportVars)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') settleVisualViewportVars()
  })
  viewport?.addEventListener('resize', updateVisualViewportVars)
  viewport?.addEventListener('scroll', updateVisualViewportVars)
}
