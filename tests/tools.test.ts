import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReadingTools, permittedParagraphs, verifiedCitations } from '../src/core/tools'
import type { BookRecord, Paragraph, ReadingPoint } from '../src/core/types'

const book: BookRecord = {
  id: 'a'.repeat(64),
  version: `sha256:${'a'.repeat(64)}`,
  title: '测试书',
  author: '测试',
  language: 'zh',
  fileName: 'test.epub',
  addedAt: '2026-10-13T00:00:00.000Z',
  coverTone: 0,
}
const paragraphs: Paragraph[] = [
  {
    id: 'p_0_0',
    sectionIndex: 0,
    ordinal: 0,
    text: '丞相负责政务。',
    cfi: 'cfi0',
    chapter: '第一章',
  },
  {
    id: 'p_0_1',
    sectionIndex: 0,
    ordinal: 1,
    text: '中文😀é 原文。后半段是未读内容。',
    cfi: 'cfi1',
    chapter: '第一章',
  },
  {
    id: 'p_1_0',
    sectionIndex: 1,
    ordinal: 2,
    text: '后文秘密。丞相在后文再次出现。',
    cfi: 'cfi2',
    chapter: '结局秘密章节',
  },
]
const point: ReadingPoint = {
  locator: {
    cfi: 'cfi1',
    sectionIndex: 0,
    paragraphId: 'p_0_1',
    endOffset: '中文😀é 原文。'.length,
    progress: 0.4,
  },
  text: '中文😀é 原文。',
  isSelection: true,
}

describe('frozen, scoped reading grants', () => {
  beforeEach(() => {
    vi.useRealTimers()
  })
  it('truncates exactly at a UTF-16 reading boundary without leaking later paragraphs or labels', () => {
    const tools = new ReadingTools(book, paragraphs, point, 'to-position')
    expect(JSON.stringify(tools.snapshot)).not.toMatch(/未读|后文|结局/)
    expect(tools.search({ query: '丞相' }).fragments).toHaveLength(1)
    expect(tools.search({ query: '未读' }).fragments).toHaveLength(0)
    const result = tools.read({ ref: tools.snapshot.initial.at(-1)!.ref, direction: 'after' })
    expect(result.fragments).toHaveLength(0)
  })
  it('does not follow mutable source data or a later page turn', () => {
    const sources = structuredClone(paragraphs)
    const location = structuredClone(point)
    const tools = new ReadingTools(book, sources, location, 'to-position')
    sources[0].text = 'MUTATED'
    location.locator.paragraphId = 'p_1_0'
    expect(tools.search({ query: '丞相' }).fragments[0].text).toBe('丞相负责政务。')
    expect(tools.snapshot.locator.paragraphId).toBe('p_0_1')
  })
  it('rejects foreign refs, injected parameters, stale cursors, cancellation and expiration', () => {
    const first = new ReadingTools(book, paragraphs, point, 'book')
    const second = new ReadingTools(book, paragraphs, point, 'book')
    expect(() => second.read({ ref: first.snapshot.initial[0].ref })).toThrow(/不属于/)
    expect(() => first.search({ query: '丞相', bookId: 'another' })).toThrow(/参数/)
    expect(() => first.search({ query: '丞相', cursor: 'invented' })).toThrow(/游标/)
    first.revoke()
    expect(() => first.read({ ref: first.snapshot.initial[0].ref })).toThrow(/取消/)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T00:00:00Z'))
    const expired = new ReadingTools(book, paragraphs, point, 'book')
    vi.advanceTimersByTime(15 * 60_000 + 1)
    expect(() => expired.search({ query: '丞相' })).toThrow(/过期/)
  })
  it('supports short Chinese terms and host-issued pagination without swapping queries', () => {
    const tools = new ReadingTools(book, paragraphs, point, 'book')
    const result = tools.search({ query: '丞相', maxResults: 1 })
    expect(result.nextCursor).toBeTruthy()
    expect(result.indexStatus).toBe('scan')
    const next = tools.search({ query: '丞相', maxResults: 1, cursor: result.nextCursor })
    expect(next.fragments[0].text).toContain('后文')
    expect(() => tools.search({ query: '别的', cursor: result.nextCursor })).toThrow(/游标/)
  })
  it('enforces cumulative character and invocation budgets', () => {
    const large = paragraphs.map((p) => ({ ...p, text: '原'.repeat(20_000) }))
    const tools = new ReadingTools(
      book,
      large,
      { ...point, locator: { ...point.locator, endOffset: 20_000 } },
      'book',
    )
    const ref = tools.snapshot.initial[0].ref
    let total = 0
    for (let i = 0; i < 3; i++)
      total += tools
        .read({ ref, maxChars: 8000, paragraphs: 1 })
        .fragments.reduce((sum, f) => sum + f.text.length, 0)
    expect(total).toBe(24_000)
    expect(() => tools.search({ query: '原' })).toThrow(/上限/)
    const bounded = new ReadingTools(book, paragraphs, point, 'book')
    for (let i = 0; i < 6; i++) bounded.search({ query: '不存在' })
    expect(() => bounded.search({ query: '不存在' })).toThrow(/上限/)
  })
  it('keeps chapter and full-book grants distinct and only verifies issued citations', () => {
    expect(permittedParagraphs(paragraphs, point, 'chapter')).toHaveLength(2)
    const tools = new ReadingTools(book, paragraphs, point, 'book')
    const cite = tools.snapshot.initial[0].citationId
    expect(verifiedCitations(`说明 [[${cite}]] [[cite_fake]]`, tools.allEvidence())).toBe(
      `说明 [原文](readweave:${cite}) （引用未核验）`,
    )
  })
  it('does not give fabricated literal quotations a verified citation button', () => {
    const tools = new ReadingTools(book, paragraphs, point, 'book')
    const cite = tools.snapshot.initial[0].citationId
    expect(verifiedCitations(`“这是编造的引文” [[${cite}]]`, tools.allEvidence())).toContain(
      '引文与原文不匹配',
    )
    expect(verifiedCitations(`> 丞相飞到了月球。 [[${cite}]]\n`, tools.allEvidence())).toContain(
      '引文与原文不匹配',
    )
    expect(verifiedCitations(`“丞相负责政务。” [[${cite}]]`, tools.allEvidence())).toContain(
      `[原文](readweave:${cite})`,
    )
  })
})
