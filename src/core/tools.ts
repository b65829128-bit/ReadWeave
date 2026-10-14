import { z } from 'zod'
import type {
  BookRecord,
  Fragment,
  Locator,
  Paragraph,
  ReadingPoint,
  ReadScope,
  Snapshot,
} from './types'
import contract from './reading-contract.json'
import { textSlice, textTail, validTextOffset } from './text'

export const searchInput = z
  .object({
    query: z.string().trim().min(1).max(160),
    maxResults: z.number().int().min(1).max(5).optional(),
    cursor: z.string().max(100).optional(),
  })
  .strict()
export const passageInput = z
  .object({
    ref: z.string().min(1).max(100),
    direction: z.enum(['around', 'before', 'after']).optional(),
    paragraphs: z.number().int().min(1).max(6).optional(),
    maxChars: z.number().int().min(1).max(8000).optional(),
  })
  .strict()
export type ToolErrorCode =
  | 'RUN_REVOKED'
  | 'RUN_EXPIRED'
  | 'INVALID_ARGUMENT'
  | 'INVALID_REFERENCE'
  | 'OUTSIDE_SCOPE'
  | 'BUDGET_EXCEEDED'
  | 'BOOK_VERSION_MISMATCH'
  | 'INDEX_NOT_READY'
  | 'TRANSFORM_MISMATCH'
  | 'INVALID_BOUNDARY'
  | 'CALLER_MISMATCH'
  | 'RUN_NOT_FOUND'
  | 'RUN_LIMIT'
  | 'ANCHOR_STALE'
  | 'STORAGE_FAILED'
export class ReadingToolError extends Error {
  constructor(
    public code: ToolErrorCode,
    message: string,
  ) {
    super(message)
  }
}
export interface ToolResult {
  schemaVersion: 1
  snapshotId: string
  bookVersion: string
  fragments: Fragment[]
  truncated: boolean
  nextCursor: string | null
  indexStatus: 'scan'
}
const opaque = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`

export function permittedParagraphs(
  paragraphs: readonly Paragraph[],
  point: ReadingPoint,
  scope: ReadScope,
): Paragraph[] {
  const boundary = paragraphs.find((p) => p.id === point.locator.paragraphId)
  if (!boundary) throw new ReadingToolError('OUTSIDE_SCOPE', '阅读位置尚未就绪，请稍后重试。')
  if (
    boundary.sectionIndex !== point.locator.sectionIndex ||
    !validTextOffset(boundary.text, point.locator.endOffset)
  )
    throw new ReadingToolError('INVALID_BOUNDARY', '阅读边界无效，请重新选择原文。')
  return paragraphs
    .filter(
      (p) =>
        scope === 'book' ||
        (scope === 'chapter'
          ? p.sectionIndex === boundary.sectionIndex
          : p.ordinal <= boundary.ordinal),
    )
    .map((p) => ({
      ...p,
      text:
        scope === 'to-position' && p.id === boundary.id
          ? p.text.slice(0, point.locator.endOffset)
          : p.text,
    }))
    .filter((p) => p.text.length > 0)
}

/** A run owns a cloned grant. Models only receive opaque refs; they cannot change the book or boundary. */
export class ReadingTools {
  readonly runId = opaque('run')
  readonly snapshot: Snapshot
  private readonly allowed: Paragraph[]
  private readonly refs = new Map<string, Paragraph>()
  private readonly anchors = new Map<string, Locator>()
  private readonly citations = new Map<string, Fragment>()
  private readonly cursors = new Map<string, { query: string; offset: number }>()
  private revoked = false
  private calls = 0
  private emitted = 0
  private readonly expiresAt: number

  constructor(
    book: BookRecord,
    paragraphs: readonly Paragraph[],
    point: ReadingPoint,
    scope: ReadScope,
    now = Date.now(),
  ) {
    this.allowed = permittedParagraphs(paragraphs, point, scope)
    this.expiresAt = now + contract.ttlMs
    const boundary = paragraphs.find((p) => p.id === point.locator.paragraphId)!
    this.snapshot = {
      id: opaque('snap'),
      bookId: book.id,
      bookVersion: book.version,
      bookTitle: book.title,
      chapter: boundary.chapter,
      createdAt: new Date(now).toISOString(),
      scope,
      locator: structuredClone(point.locator),
      selection: point.isSelection ? textSlice(point.text, 0, contract.maxInitialUnits).text : '',
      initial: [],
    }
    const near = this.allowed
      .filter((p) => p.sectionIndex === boundary.sectionIndex && p.ordinal <= boundary.ordinal)
      .slice(-4)
    let remaining = contract.maxInitialUnits
    // Prefer the question location, then add preceding complete paragraphs when they fit.
    for (const paragraph of near.reverse()) {
      if (remaining <= 0) break
      const { text, start } = textTail(paragraph.text, remaining)
      if (!text) continue
      const fragment = this.issue(paragraph, text, start)
      this.snapshot.initial.unshift(fragment)
      remaining -= text.length
    }
  }

  private check() {
    if (this.revoked) throw new ReadingToolError('RUN_REVOKED', '本次任务已取消，读取授权已撤销。')
    if (Date.now() > this.expiresAt)
      throw new ReadingToolError('RUN_EXPIRED', '本次读取授权已过期，请重新提问。')
    if (++this.calls > contract.maxCalls || this.emitted >= contract.maxOutputUnits)
      throw new ReadingToolError('BUDGET_EXCEEDED', '已达到本轮取证上限。请基于已有原文回答。')
  }
  private issue(paragraph: Paragraph, text = paragraph.text, start = 0): Fragment {
    const ref = opaque('passage')
    const anchorRef = opaque('anchor')
    const fragment = { citationId: opaque('cite'), ref, anchorRef, text, label: paragraph.chapter }
    this.refs.set(ref, paragraph)
    this.anchors.set(anchorRef, {
      cfi: paragraph.cfi,
      sectionIndex: paragraph.sectionIndex,
      paragraphId: paragraph.id,
      endOffset: start + text.length,
      progress: 0,
      quote: { exact: textSlice(text, 0, 240).text, prefix: '', suffix: '' },
    })
    this.citations.set(fragment.citationId, fragment)
    return fragment
  }
  private result(
    fragments: Fragment[],
    truncated = false,
    nextCursor: string | null = null,
  ): ToolResult {
    return {
      schemaVersion: 1,
      snapshotId: this.snapshot.id,
      bookVersion: this.snapshot.bookVersion,
      fragments,
      truncated,
      nextCursor,
      indexStatus: 'scan',
    }
  }
  search(raw: unknown): ToolResult {
    this.check()
    const parsed = searchInput.safeParse(raw)
    if (!parsed.success) throw new ReadingToolError('INVALID_ARGUMENT', '搜索参数无效。')
    const { query, maxResults = 5, cursor } = parsed.data
    const continuation = cursor ? this.cursors.get(cursor) : undefined
    if (cursor && (!continuation || continuation.query !== query))
      throw new ReadingToolError('INVALID_REFERENCE', '搜索游标不属于本次查询。')
    const matches = this.allowed.filter((p) => p.text.toLowerCase().includes(query.toLowerCase()))
    const start = continuation?.offset ?? 0
    const subset = matches.slice(start, start + maxResults)
    let budget = Math.min(6000, contract.maxOutputUnits - this.emitted)
    const fragments = subset.flatMap((paragraph) => {
      if (budget <= 0) return []
      const lower = query.toLowerCase()
      let match = 0
      let lowered = 0
      const lowerMatch = paragraph.text.toLowerCase().indexOf(lower)
      for (const character of paragraph.text) {
        const length = character.toLowerCase().length
        if (lowered + length > lowerMatch) break
        lowered += length
        match += character.length
      }
      const { text, start } = textSlice(
        paragraph.text,
        Math.max(0, match - 120),
        Math.min(1000, budget),
      )
      if (!text) return []
      budget -= text.length
      this.emitted += text.length
      return [this.issue(paragraph, text, start)]
    })
    const hasMore = start + fragments.length < matches.length
    const next = hasMore ? opaque('cursor') : null
    if (next) this.cursors.set(next, { query, offset: start + fragments.length })
    return this.result(fragments, hasMore || subset.some((p) => p.text.length > 1000), next)
  }
  read(raw: unknown): ToolResult {
    this.check()
    const parsed = passageInput.safeParse(raw)
    if (!parsed.success) throw new ReadingToolError('INVALID_ARGUMENT', '片段读取参数无效。')
    const { ref, direction = 'around', paragraphs = 3, maxChars = 6000 } = parsed.data
    const paragraph = this.refs.get(ref)
    if (!paragraph) throw new ReadingToolError('INVALID_REFERENCE', '片段引用不属于本次任务。')
    const index = this.allowed.findIndex((p) => p.id === paragraph.id)
    const start =
      direction === 'before'
        ? Math.max(0, index - paragraphs)
        : direction === 'after'
          ? index + 1
          : Math.max(0, index - Math.floor(paragraphs / 2))
    const end = direction === 'before' ? index : start + paragraphs
    const selected = this.allowed.slice(start, end)
    let budget = Math.min(maxChars, contract.maxOutputUnits - this.emitted)
    let truncated = false
    const fragments = selected.flatMap((item) => {
      if (budget <= 0) {
        truncated = true
        return []
      }
      const text = textSlice(item.text, 0, budget).text
      truncated ||= text.length < item.text.length
      if (!text) return []
      budget -= text.length
      this.emitted += text.length
      return [this.issue(item, text)]
    })
    return this.result(fragments, truncated)
  }
  revoke() {
    this.revoked = true
  }
  allEvidence(): Fragment[] {
    return [...this.citations.values()].map((item) => ({ ...item }))
  }
  resolveAnchor(anchor: string): Locator | null {
    const locator = this.anchors.get(anchor)
    return locator ? structuredClone(locator) : null
  }
}

export function verifiedCitations(markdown: string, evidence: readonly Fragment[]): string {
  const ids = new Set(evidence.map((fragment) => fragment.citationId))
  const normalize = (text: string) => text.replace(/\s+/g, ' ').trim()
  const matchesQuote = (id: string, quote: string) =>
    evidence.some(
      (fragment) =>
        fragment.citationId === id && normalize(fragment.text).includes(normalize(quote)),
    )
  let checked = markdown.replace(
    /([“"])([^”"\n]{4,})[”"]\s*\[\[(cite_[a-zA-Z0-9]+)\]\]/g,
    (match, _opening: string, quote: string, id: string) =>
      ids.has(id) && !matchesQuote(id, quote)
        ? match.replace(`[[${id}]]`, '（引文与原文不匹配）')
        : match,
  )
  checked = checked.replace(
    /(^|\n)((?:>[^\n]*(?:\n|$))+)/g,
    (match, _prefix: string, block: string) => {
      const quote = block
        .replace(/^>\s?/gm, '')
        .replace(/\[\[cite_[a-zA-Z0-9]+\]\]/g, '')
        .trim()
      return match.replace(/\[\[(cite_[a-zA-Z0-9]+)\]\]/g, (marker: string, id: string) =>
        ids.has(id) && quote && !matchesQuote(id, quote) ? '（引文与原文不匹配）' : marker,
      )
    },
  )
  return checked.replace(/\[\[(cite_[a-zA-Z0-9]+)\]\]/g, (_match, id: string) =>
    ids.has(id) ? `[原文](readweave:${id})` : '（引用未核验）',
  )
}

export const readingToolDefinitions = [
  {
    type: 'function',
    function: {
      name: 'book_search',
      description:
        '在当前冻结任务的授权书籍和读取范围内搜索原文。使用短且具体的词语。最多返回五条，indexStatus=scan 表示受限文本扫描。',
      parameters: z.toJSONSchema(searchInput),
    },
  },
  {
    type: 'function',
    function: {
      name: 'book_read_passage',
      description:
        '读取宿主签发的不透明 ref 对应片段或少量邻近段落。不能访问路径、URL、其他书籍或范围之外的正文。',
      parameters: z.toJSONSchema(passageInput),
    },
  },
]
