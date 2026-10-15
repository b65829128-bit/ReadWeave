import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storage } from '../src/core/storage'

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: bridge.invoke }))

describe('native book byte transport', () => {
  beforeEach(() => {
    vi.stubGlobal('Blob', NodeBlob)
    bridge.invoke.mockReset()
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Windows')
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })
  it('uploads Windows EPUB bytes without constructing a JSON number array', async () => {
    const bytes = new Uint8Array([0, 255, 128, 13, 10])
    await storage.putBlob('a'.repeat(64), new Blob([bytes]))
    const [command, body, options] = bridge.invoke.mock.calls[0]
    expect(command).toBe('book_blob_put_binary')
    expect(Object.prototype.toString.call(body)).toBe('[object ArrayBuffer]')
    expect(new Uint8Array(body)).toEqual(bytes)
    expect(options).toEqual({ headers: { 'x-readweave-book': 'a'.repeat(64) } })
  })
  it('retains the supported JSON request path for Android', async () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Android')
    await storage.putBlob('a'.repeat(64), new Blob([new Uint8Array([0, 255])]))
    expect(bridge.invoke).toHaveBeenCalledWith('book_blob_put', {
      key: 'a'.repeat(64),
      bytes: [0, 255],
    })
  })
  it('reads binary responses and the array response fallback without changing bytes', async () => {
    for (const response of [new Uint8Array([0, 255, 128]).buffer, [0, 255, 128]]) {
      bridge.invoke.mockResolvedValueOnce(response)
      const blob = await storage.getBlob('a'.repeat(64))
      expect(blob?.type).toBe('application/epub+zip')
      expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]))
    }
  })
  it('preserves not-found handling and propagates other native storage failures', async () => {
    bridge.invoke.mockRejectedValueOnce('BOOK_NOT_FOUND')
    expect(await storage.getBlob('a'.repeat(64))).toBeUndefined()
    bridge.invoke.mockRejectedValueOnce('BOOK_TOO_LARGE')
    await expect(storage.getBlob('a'.repeat(64))).rejects.toBe('BOOK_TOO_LARGE')
  })
})
