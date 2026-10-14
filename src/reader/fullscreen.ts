import { isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'

/** Return a release function only when this action took ownership of system fullscreen. */
export async function requestReaderFullscreen(): Promise<() => Promise<void>> {
  if (isTauri()) {
    const window = getCurrentWindow()
    if (await window.isFullscreen()) return async () => {}
    await window.setFullscreen(true)
    return () => window.setFullscreen(false)
  }
  if (document.fullscreenElement) return async () => {}
  await document.documentElement.requestFullscreen()
  return async () => {
    if (document.fullscreenElement) await document.exitFullscreen()
  }
}
