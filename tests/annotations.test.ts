import { describe, expect, it } from 'vitest'
import { isSamePassage, overlapsPassage } from '../src/core/annotations'
import type { Annotation, ReadingPoint } from '../src/core/types'

const annotation: Annotation = {
  id: 'a',
  bookId: 'b',
  bookVersion: 'v',
  kind: 'highlight',
  text: '重复的句子',
  note: '',
  chapter: '第一章',
  createdAt: '',
  locator: {
    cfi: 'first-range',
    sectionIndex: 0,
    paragraphId: 'p_0_1',
    endOffset: 12,
    progress: 0.1,
  },
}
describe('passage identity', () => {
  it('matches overlapping highlights without merging adjacent or other-chapter passages', () => {
    const mark = {
      ...annotation,
      locator: { ...annotation.locator, cfi: 'epubcfi(/6/2!/4,/2/1:2,/2/1:12)' },
    }
    const point: ReadingPoint = {
      text: '句子',
      isSelection: true,
      locator: { ...mark.locator, cfi: 'epubcfi(/6/2!/4,/2/1:5,/2/1:8)', endOffset: 8 },
    }
    expect(overlapsPassage(mark, point)).toBe(true)
    expect(
      overlapsPassage(mark, {
        ...point,
        locator: { ...point.locator, cfi: 'epubcfi(/6/2!/4,/2/1:12,/2/1:16)' },
      }),
    ).toBe(false)
    expect(
      overlapsPassage(mark, { ...point, locator: { ...point.locator, sectionIndex: 1 } }),
    ).toBe(false)
  })
  it('matches reselected text at the same boundaries even if range serialization differs', () => {
    const point: ReadingPoint = {
      text: annotation.text,
      locator: { ...annotation.locator, cfi: 'equivalent-range', progress: 0.2 },
      isSelection: true,
    }
    expect(isSamePassage(annotation, point)).toBe(true)
    expect(
      isSamePassage(annotation, { ...point, locator: { ...point.locator, endOffset: 40 } }),
    ).toBe(false)
    expect(
      isSamePassage(annotation, { ...point, locator: { ...point.locator, paragraphId: 'p_0_2' } }),
    ).toBe(false)
    expect(
      isSamePassage(annotation, { ...point, locator: { ...point.locator, sectionIndex: 1 } }),
    ).toBe(false)
  })
})
