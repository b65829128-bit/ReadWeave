export const EPUB_LIMITS = {
  file: 32 * 1024 * 1024,
  expanded: 96 * 1024 * 1024,
  entry: 8 * 1024 * 1024,
  entries: 2048,
  timeout: 20_000,
}
export interface ArchiveEntry {
  path: string
  size: number
  crc: number
}

export function safeArchivePath(path: string): boolean {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return false
  }
  return (
    path.length <= 512 &&
    !/[:\\]/.test(decoded) &&
    ![...decoded].some((character) => character.charCodeAt(0) < 32) &&
    !decoded.startsWith('/') &&
    !decoded.split('/').some((part) => part === '..' || part === '.')
  )
}

/** Inspect sizes before allocating the expanded archive. ZIP64 is deliberately unsupported. */
export function inspectArchive(bytes: Uint8Array): ArchiveEntry[] {
  if (bytes.length < 22 || bytes.length > EPUB_LIMITS.file)
    throw new Error('EPUB 文件无效或超过 32 MB 上限。')
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (
      data.getUint32(i, true) === 0x06054b50 &&
      i + 22 + data.getUint16(i + 20, true) === bytes.length
    ) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('无法识别 EPUB 压缩包。')
  const count = data.getUint16(end + 10, true)
  const centralSize = data.getUint32(end + 12, true)
  let offset = data.getUint32(end + 16, true)
  const centralEnd = offset + centralSize
  if (
    data.getUint16(end + 4, true) ||
    data.getUint16(end + 6, true) ||
    count !== data.getUint16(end + 8, true) ||
    !count ||
    count > EPUB_LIMITS.entries ||
    centralEnd !== end
  )
    throw new Error('不支持分卷、ZIP64 或资源过多的 EPUB。')
  const entries: ArchiveEntry[] = []
  const paths = new Set<string>()
  let total = 0
  for (let index = 0; index < count; index++) {
    if (offset + 46 > centralEnd || data.getUint32(offset, true) !== 0x02014b50)
      throw new Error('EPUB 资源目录损坏。')
    const flags = data.getUint16(offset + 8, true)
    const method = data.getUint16(offset + 10, true)
    const crc = data.getUint32(offset + 16, true)
    const compressed = data.getUint32(offset + 20, true)
    const size = data.getUint32(offset + 24, true)
    const nameLength = data.getUint16(offset + 28, true)
    const extraLength = data.getUint16(offset + 30, true)
    const commentLength = data.getUint16(offset + 32, true)
    const localOffset = data.getUint32(offset + 42, true)
    if (offset + 46 + nameLength + extraLength + commentLength > centralEnd)
      throw new Error('EPUB 资源目录损坏。')
    const path = new TextDecoder('utf-8', { fatal: true }).decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    )
    const canonical = decodeURIComponent(path)
    if (!safeArchivePath(path) || paths.has(canonical))
      throw new Error('EPUB 包含不安全或重复的资源路径。')
    paths.add(canonical)
    total += size
    if (
      flags & 1 ||
      ![0, 8].includes(method) ||
      size > EPUB_LIMITS.entry ||
      total > EPUB_LIMITS.expanded ||
      (compressed > 0 && size / compressed > 300)
    )
      throw new Error('EPUB 已加密、使用不支持的压缩方式或展开体积过大。')
    if (localOffset + 30 > centralEnd || data.getUint32(localOffset, true) !== 0x04034b50)
      throw new Error('EPUB 资源记录损坏。')
    const localNameLength = data.getUint16(localOffset + 26, true)
    const localExtraLength = data.getUint16(localOffset + 28, true)
    if (localOffset + 30 + localNameLength + localExtraLength + compressed > centralEnd)
      throw new Error('EPUB 资源超出文件边界。')
    entries.push({ path, size, crc })
    offset += 46 + nameLength + extraLength + commentLength
  }
  if (offset !== centralEnd) throw new Error('EPUB 资源目录不一致。')
  return entries
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1
  return n >>> 0
})
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
