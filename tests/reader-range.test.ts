import { describe, expect, it } from 'vitest'
import { textRange } from '../src/reader/range'
import { fromRange, parse, toRange } from '../src/vendor/foliate/epubcfi.js'

describe('reader text anchors', () => {
  it('bulk CFI caching preserves anchors for nested elements, split text, IDs and UTF-16', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><section id="章,一"><h1>标题</h1><!-- inert --><p id="p]一">开始<b>中😀间</b>结束</p><div><p>另一段</p></div></section></body></html>',
      'text/html',
    )
    const paragraph = doc.querySelector('p')!
    paragraph.append(doc.createTextNode('相邻'), doc.createTextNode('文本'))
    const cache = new WeakMap<Node, unknown[]>()
    for (const element of doc.querySelectorAll('h1,p')) {
      const source = doc.createRange()
      source.selectNodeContents(element)
      const range = textRange(source)
      const expected = fromRange(range)
      const actual = fromRange(range, undefined, cache)
      expect(actual).toBe(expected)
      expect(fromRange(range, undefined, cache)).toBe(expected)
      expect(toRange(doc, parse(actual)).toString()).toBe(range.toString())
      range.collapse(true)
      expect(fromRange(range, undefined, cache)).toBe(fromRange(range))
    }
  })
  it('round-trips whole paragraphs with inline nodes and UTF-16 text through CFI', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><p>理解<b>一个😀</b>问题。</p><p>下一段</p></body></html>',
      'text/html',
    )
    const source = doc.createRange()
    source.selectNodeContents(doc.querySelector('p')!)
    const range = textRange(source)
    expect(range.toString()).toBe(source.toString())
    const restored = toRange(doc, parse(fromRange(range)))
    expect(restored.toString()).toBe('理解一个😀问题。')
    expect(restored.collapsed).toBe(false)
  })
  it('preserves exact partial selection boundaries', () => {
    const doc = new DOMParser().parseFromString(
      '<html><body><p>开始<b>中😀间</b>结束</p></body></html>',
      'text/html',
    )
    const source = doc.createRange()
    source.setStart(doc.querySelector('b')!.firstChild!, 1)
    source.setEnd(doc.querySelector('p')!.lastChild!, 1)
    expect(textRange(source).toString()).toBe('😀间结')
    expect(toRange(doc, parse(fromRange(textRange(source)))).toString()).toBe('😀间结')
  })
})
