import { EPUB } from '../vendor/foliate/epub.js'
import * as CFI from '../vendor/foliate/epubcfi.js'
import { EPUB_LIMITS, safeArchivePath } from './archive'
import { cleanXmlDeclaration, normalizeText, sanitizeXhtml } from './sanitize'
import { sha256 } from '../core/storage'
import readingLimits from '../core/reading-contract.json'
import { textRange } from './range'
import type { BookRecord, Paragraph } from '../core/types'

export interface LoadedBook {
  book: EPUB
  record: BookRecord
  paragraphs: Paragraph[]
}

function unpack(blob: Blob): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./epub-worker.ts', import.meta.url), { type: 'module' })
    const timeout = setTimeout(() => {
      worker.terminate()
      reject(new Error('EPUB 解析超时，已停止导入。'))
    }, EPUB_LIMITS.timeout)
    const finish = () => {
      clearTimeout(timeout)
      worker.terminate()
    }
    worker.onmessage = (event) => {
      finish()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve(event.data.files)
    }
    worker.onerror = () => {
      finish()
      reject(new Error('EPUB 解析失败。'))
    }
    blob.arrayBuffer().then(
      (buffer) => worker.postMessage(buffer, [buffer]),
      (error) => {
        finish()
        reject(error)
      },
    )
  })
}

function plainMetadata(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(plainMetadata).filter(Boolean).join('、')
  if (value && typeof value === 'object') {
    const item = value as Record<string, unknown>
    return plainMetadata(item.name ?? item.value ?? Object.values(item)[0])
  }
  return ''
}

export async function openEpub(
  blob: Blob,
  fileName = 'book.epub',
  existing?: BookRecord,
): Promise<LoadedBook> {
  if (!fileName.toLowerCase().endsWith('.epub'))
    throw new Error('首版仅支持无 DRM、可重排的 EPUB。')
  if (blob.size > EPUB_LIMITS.file) throw new Error('EPUB 文件超过 32 MB 上限。')
  const [hash, files] = await Promise.all([sha256(blob), unpack(blob)])
  if (existing && existing.id !== hash) throw new Error('书籍版本不一致，请重新导入原书。')
  const cache = new Map<string, string>()
  const loadText = async (path: string): Promise<string | null> => {
    if (!safeArchivePath(path) || !files[path]) return null
    if (/\.(css|js|mjs|svg)$/i.test(path)) return ''
    if (cache.has(path)) return cache.get(path)!
    const raw = cleanXmlDeclaration(new TextDecoder().decode(files[path]))
    const isHtml = /<(?:(?:\w+):)?html[\s>]/i.test(raw)
    const text = isHtml ? sanitizeXhtml(raw) : raw
    cache.set(path, text)
    return text
  }
  const book = await new EPUB({
    loadText,
    loadBlob: async (path) =>
      safeArchivePath(path) && files[path] && !/\.(js|mjs|svg|html?|xhtml)$/i.test(path)
        ? new Blob([new Uint8Array(files[path])])
        : null,
    getSize: (path) => files[path]?.length ?? 0,
  }).init()
  try {
    if (book.rendition?.layout === 'pre-paginated')
      throw new Error('暂不支持固定版式 EPUB，请使用可重排版本。')
    if (!book.sections.length) throw new Error('EPUB 没有可读取的正文。')
    if (book.sections.length > readingLimits.maxSections)
      throw new Error(`EPUB 章节数量超过 ${readingLimits.maxSections} 节上限。`)
    book.transformTarget.addEventListener('load', (event) => {
      const detail = (event as CustomEvent).detail
      if (
        detail.isScript ||
        !/^(application\/xhtml\+xml|text\/html|image\/(png|jpeg|gif|webp)|font\/|application\/(font|vnd\.ms-opentype))/i.test(
          detail.type,
        )
      )
        detail.allow = false
    })
    const paragraphs: Paragraph[] = []
    let characters = 0
    for (let index = 0; index < book.sections.length; index++) {
      const section = book.sections[index]
      const doc = await section.createDocument()
      const chapter =
        normalizeText(doc.querySelector('h1,h2,title')?.textContent ?? '').slice(0, 500) ||
        `第 ${index + 1} 节`
      for (const element of doc.querySelectorAll('[data-rw-paragraph]')) {
        const text = normalizeText(element.textContent ?? '')
        characters += text.length
        if (characters > readingLimits.maxTextUnits)
          throw new Error('书籍正文超过当前可处理的文字总量。')
        if (paragraphs.length >= readingLimits.maxBlocks)
          throw new Error(
            `书籍段落数量超过 ${readingLimits.maxBlocks.toLocaleString('zh-CN')} 段上限。`,
          )
        const range = doc.createRange()
        range.selectNodeContents(element)
        paragraphs.push({
          id: `p_${index}_${element.getAttribute('data-rw-paragraph')}`,
          sectionIndex: index,
          ordinal: paragraphs.length,
          text,
          chapter,
          cfi: CFI.joinIndir(section.cfi, CFI.fromRange(textRange(range))),
        })
      }
    }
    if (!paragraphs.length) throw new Error('无法提取正文。扫描页、图片公式和 OCR 尚未支持。')
    const record: BookRecord = existing ?? {
      id: hash,
      version: `sha256:${hash}`,
      title: plainMetadata(book.metadata.title).slice(0, 300) || fileName.replace(/\.epub$/i, ''),
      author: plainMetadata(book.metadata.author).slice(0, 300) || '作者未注明',
      language: plainMetadata(book.metadata.language) || 'zh',
      fileName,
      addedAt: new Date().toISOString(),
      coverTone: parseInt(hash.slice(0, 2), 16) % 5,
    }
    return { book, record, paragraphs }
  } catch (error) {
    book.destroy()
    throw error
  }
}
