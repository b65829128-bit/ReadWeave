import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { crc32, inspectArchive, safeArchivePath } from '../src/reader/archive'
import { normalizeHtmlEntities, sanitizeXhtml } from '../src/reader/sanitize'
import { defaultPack, parsePack, renderAction } from '../src/core/plugins'
import { completionEndpoint, SseDecoder } from '../src/harness/provider'

describe('untrusted EPUB import', () => {
  it('accepts our real sample archive and validates UTF-8 Chinese paths', () => {
    const entries = inspectArchive(
      new Uint8Array(readFileSync('public/samples/understanding.epub')),
    )
    expect(entries.some((e) => e.path === 'EPUB/package.opf')).toBe(true)
    expect(safeArchivePath('EPUB/章节一.xhtml')).toBe(true)
    expect(crc32(strToU8('123456789'))).toBe(0xcbf43926)
  })
  it('rejects traversal, duplicate normalized paths, oversized expansion and malformed archives', () => {
    for (const path of [
      '../a',
      'a/../../b',
      '/absolute',
      'C:/file',
      'a\\b',
      '%2e%2e/file',
      'a/%2f../b',
    ])
      expect(safeArchivePath(path)).toBe(false)
    expect(() => inspectArchive(zipSync({ '../escape': strToU8('bad') }))).toThrow(/路径/)
    expect(() => inspectArchive(zipSync({ 'a%20b': strToU8('1'), 'a b': strToU8('2') }))).toThrow(
      /重复/,
    )
    const bomb = zipSync({ bomb: new Uint8Array(1024 * 1024) })
    expect(() => inspectArchive(bomb)).toThrow(/过大/)
    expect(() => inspectArchive(new Uint8Array([1, 2, 3]))).toThrow()
  })
  it('removes active content, remote resources, CSS, forged locators and dangerous URLs', () => {
    const html = sanitizeXhtml(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>章节</title><style>@import "https://evil.example/";</style></head><body onload="alert(1)"><p data-rw-paragraph="999" onclick="alert(1)" style="background:url(https://evil.example)">中文😀é</p><script>window.parent.__TAURI_INTERNALS__.invoke("record_get")</script><iframe src="https://evil.example"/><img src="https://evil.example/track"/><a href="javascript:alert(1)">危险</a><form action="https://evil.example"/><svg><foreignObject>坏</foreignObject></svg></body></html>',
    )
    const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('script,iframe,form,svg,style')).toBeNull()
    expect(doc.querySelector('[onclick],[onload],[style]')).toBeNull()
    expect(doc.querySelector('img')?.getAttribute('src')).toBeNull()
    expect(doc.querySelector('a')?.getAttribute('href')).toBeNull()
    expect(doc.querySelector('p')?.getAttribute('data-rw-paragraph')).toBe('0')
    expect(html).toContain("script-src 'none'")
    expect(doc.querySelector('p')?.textContent).toBe('中文😀é')
  })
  it('accepts standard HTML named entities without interpreting decoded text as markup', () => {
    const html = sanitizeXhtml(
      '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd"><html xmlns="http://www.w3.org/1999/xhtml"><head><title>兼容书籍</title></head><body><p>甲&nbsp;乙&mdash;&hellip;&copy;&NotEqualTilde; &amp;nbsp; &lt;script&gt;alert(1)&lt;/script&gt;</p><a href="java&NewLine;script:alert(1)">链接</a></body></html>',
    )
    const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('p')?.textContent).toBe(
      '甲\u00a0乙—…©≂̸ &nbsp; <script>alert(1)</script>',
    )
    expect(doc.querySelector('script')).toBeNull()
    expect(doc.querySelector('a')?.getAttribute('href')).toBeNull()
  })
  it('does not rewrite entity-like literal text in CDATA, comments or processing instructions', () => {
    const html = normalizeHtmlEntities(
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>字面文本</title></head><body><!-- &unknownEntity; --><?note &unknownEntity;?><p><![CDATA[甲&nbsp;乙 &copy; &unknownEntity; <script>字面标签</script>]]></p></body></html>',
    )
    const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('p')?.textContent).toBe(
      '甲&nbsp;乙 &copy; &unknownEntity; <script>字面标签</script>',
    )
    expect(doc.querySelector('script')).toBeNull()
  })
  it('still rejects custom XML entities, unknown entities and malformed chapter markup', () => {
    for (const declaration of [
      '<!DOCTYPE html [<!ENTITY secret SYSTEM "file:///private">]>',
      '<!DOCTYPE html [<!ENTITY secret "expanded">]>',
    ])
      expect(() =>
        sanitizeXhtml(`${declaration}<html><body><p>&secret;</p></body></html>`),
      ).toThrow(/实体声明/)
    for (const entity of ['&unknownEntity;', '&notAnEntity;', '&copyInvalid;'])
      expect(() => sanitizeXhtml(`<html><body><p>${entity}</p></body></html>`)).toThrow(/无法解析/)
    expect(() => sanitizeXhtml('<html><body><p>未闭合</body></html>')).toThrow(/无法解析/)
  })
})

describe('EPUB navigation', () => {
  it('preserves the EPUB navigation namespace after sanitizing XHTML', () => {
    const html = sanitizeXhtml(
      '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="chapter.xhtml">一</a></li></ol></nav></body></html>',
    )
    const doc = new DOMParser().parseFromString(html, 'application/xhtml+xml')
    expect(doc.querySelector('parsererror')).toBeNull()
    expect(doc.querySelector('nav')?.getAttributeNS('http://www.idpf.org/2007/ops', 'type')).toBe(
      'toc',
    )
  })
})

describe('declarative actions', () => {
  it('accepts real packs and performs literal substitution only', () => {
    expect(parsePack(JSON.stringify(defaultPack)).id).toBe(defaultPack.id)
    const fields = {
      title: '书',
      chapter: '一',
      selection: '${process.env.SECRET}',
      question: '为什么',
    }
    expect(
      renderAction(
        { ...defaultPack.actions[0], promptTemplate: '{{selection}} / {{title}}' },
        fields,
      ),
    ).toBe('${process.env.SECRET} / 书')
  })
  it('rejects executable fields, implicit permissions, duplicate actions and unknown template variables', () => {
    for (const changes of [
      { script: 'alert(1)' },
      { permissions: ['network'] },
      { actions: [defaultPack.actions[0], defaultPack.actions[0]] },
      { actions: [{ ...defaultPack.actions[0], promptTemplate: '{{apiKey}}' }] },
    ])
      expect(() => parsePack(JSON.stringify({ ...defaultPack, ...changes }))).toThrow()
  })
})

describe('model transport', () => {
  it('requires HTTPS remotely and does not permit credentials in URLs', () => {
    expect(completionEndpoint('https://provider.example/v1/')).toBe(
      'https://provider.example/v1/chat/completions',
    )
    expect(completionEndpoint('http://localhost:1234/v1')).toContain('localhost:1234')
    for (const endpoint of [
      'http://192.168.0.2/v1',
      'javascript:alert(1)',
      'https://key@provider.example/v1',
      'https://provider.example/v1?api_key=secret',
    ])
      expect(() => completionEndpoint(endpoint)).toThrow()
  })
  it('reassembles split SSE records, CRLF and tool argument chunks', () => {
    const output: string[] = []
    const decoder = new SseDecoder((delta) =>
      output.push(delta.content ?? delta.tool_calls?.[0].function?.arguments ?? ''),
    )
    const stream = `data: ${JSON.stringify({ choices: [{ delta: { content: '中文😀' } }] })}\r\n\r\ndata: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"梯度"}' } }] } }] })}\n\ndata: [DONE]\n\n`
    for (const character of stream) decoder.push(character)
    decoder.finish()
    expect(output).toEqual(['中文😀', '{"query":"梯度"}'])
  })
  it('marks a truncated stream as incomplete', () => {
    const decoder = new SseDecoder(() => undefined)
    decoder.push('data: {"choices":[{"delta":{"content":"部分回答"}}]}\n\n')
    expect(() => decoder.finish()).toThrow(/中断/)
  })
  it('streams reasoning separately and exposes provider length limits instead of marking success', () => {
    const reasoning: string[] = []
    const decoder = new SseDecoder((delta) => {
      if (delta.reasoning_content) reasoning.push(delta.reasoning_content)
    })
    decoder.push('data: {"choices":[{"delta":{"reasoning_content":"先检查原文😀"}}]}\n\n')
    expect(reasoning).toEqual(['先检查原文😀'])
    expect(() =>
      decoder.push('data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'),
    ).toThrow(/输出预算/)
  })
})
