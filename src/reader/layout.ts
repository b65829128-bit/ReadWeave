/** The keyboard changes window height, but must not change the reader's panel placement. */
export function trackReaderLayout() {
  const touch = window.matchMedia('(pointer: coarse)')
  const orientation = window.screen.orientation
  const update = () => {
    const portrait = orientation?.type
      ? orientation.type.startsWith('portrait')
      : window.screen.height >= window.screen.width
    document.documentElement.dataset.readerPanel =
      window.innerWidth <= 800 || (touch.matches && portrait) ? 'bottom' : 'side'
  }
  update()
  window.addEventListener('resize', update)
  orientation?.addEventListener('change', update)
  touch.addEventListener('change', update)
  return () => {
    window.removeEventListener('resize', update)
    orientation?.removeEventListener('change', update)
    touch.removeEventListener('change', update)
  }
}
