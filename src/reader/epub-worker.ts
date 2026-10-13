import { unzipSync, strFromU8 } from 'fflate'
import { inspectArchive, crc32 } from './archive'

self.onmessage = (event: MessageEvent<ArrayBuffer>) => {
  try {
    const bytes = new Uint8Array(event.data)
    const manifest = inspectArchive(bytes)
    const files = unzipSync(bytes)
    for (const entry of manifest) {
      const file = files[entry.path]
      if (!file || file.length !== entry.size || crc32(file) !== entry.crc)
        throw new Error('EPUB 资源校验失败。')
    }
    if (
      strFromU8(files.mimetype ?? new Uint8Array()).trim() !== 'application/epub+zip' ||
      !files['META-INF/container.xml']
    )
      throw new Error('请导入无 DRM 的 EPUB 文件。')
    if (files['META-INF/rights.xml']) throw new Error('此 EPUB 可能包含 DRM，目前不支持。')
    self.postMessage({ files }, { transfer: Object.values(files).map((bytes) => bytes.buffer) })
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'EPUB 解析失败。' })
  }
}
