import DOMPurify from 'dompurify'

export const paragraphSelector = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption,dd,dt'
export const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim()
export function cleanXmlDeclaration(source: string): string {
  if (/<!ENTITY|<!DOCTYPE[^>]*\[/i.test(source)) {
    throw new Error('EPUB 包含不支持的 XML 实体声明。')
  }
  // A normal EPUB 2/3 doctype is inert after removal. Never resolve its external DTD.
  return source.replace(/<!DOCTYPE\s+[^>]*>/gi, '')
}
export const BOOK_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'"

export function normalizeHtmlEntities(source: string): string {
  const xmlEntities = new Set(['amp', 'lt', 'gt', 'quot', 'apos'])
  const decoded = new Map<string, string>()
  const decoder = globalThis.document.createElement('span')
  return source.replace(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|&([a-z][a-z0-9]+);/gi,
    (entity: string, name: string | undefined) => {
      if (!name || xmlEntities.has(name)) return entity
      if (!decoded.has(entity)) {
        // Only an entity token reaches the detached decoder, never publication markup or a DTD.
        // Attribute parsing requires the complete name; text parsing also expands legacy prefixes.
        decoder.innerHTML = `<span title="${entity}"></span>`
        const value = decoder.firstElementChild!.getAttribute('title')!
        decoded.set(
          entity,
          value === entity
            ? entity
            : [...value].map((character) => `&#${character.codePointAt(0)};`).join(''),
        )
      }
      return decoded.get(entity)!
    },
  )
}

export function sanitizeXhtml(source: string): string {
  if (source.length > 2 * 1024 * 1024) throw new Error('EPUB 单章文本超过 2 MiB 上限。')
  const document = new DOMParser().parseFromString(
    normalizeHtmlEntities(cleanXmlDeclaration(source)),
    'application/xhtml+xml',
  )
  if (document.querySelector('parsererror'))
    throw new Error('EPUB 章节结构无法解析，可能存在未闭合标签或不支持的实体。')
  const clean = DOMPurify.sanitize(document.documentElement, {
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
    USE_PROFILES: { html: true, mathMl: true },
    ADD_ATTR: ['epub:type', 'xmlns', 'xml:lang'],
    FORBID_TAGS: [
      'script',
      'iframe',
      'frame',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'meta',
      'base',
      'link',
      'style',
      'audio',
      'video',
      'source',
      'svg',
    ],
    FORBID_ATTR: ['style', 'srcset', 'ping', 'autofocus', 'formaction', 'target', 'download'],
  }) as HTMLElement
  const doc = new DOMParser().parseFromString(clean.outerHTML, 'text/html')
  for (const element of doc.querySelectorAll('*')) {
    // EPUB cannot set host locator identifiers or trigger automatic remote requests.
    for (const attr of [...element.attributes]) {
      if (/^on|^data-rw-/i.test(attr.name)) element.removeAttribute(attr.name)
      if (['src', 'href', 'xlink:href', 'poster', 'background'].includes(attr.name)) {
        const value = [...attr.value].filter((character) => character.charCodeAt(0) > 32).join('')
        const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
        const allowedAnchor =
          element.localName === 'a' &&
          attr.name === 'href' &&
          ['https', 'http'].includes(scheme ?? '')
        const safeDataImage =
          element.localName === 'img' && /^data:image\/(png|jpeg|gif|webp);base64,/i.test(value)
        if (
          (scheme && !allowedAnchor && !safeDataImage) ||
          value.startsWith('//') ||
          value.startsWith('\\')
        )
          element.removeAttribute(attr.name)
      }
    }
  }
  const blocks = [...doc.body.querySelectorAll(paragraphSelector)].filter(
    (el) => !el.querySelector(paragraphSelector),
  )
  if (!blocks.length && normalizeText(doc.body.textContent ?? '')) {
    const paragraph = doc.createElement('p')
    paragraph.append(...doc.body.childNodes)
    doc.body.append(paragraph)
    blocks.push(paragraph)
  }
  let index = 0
  for (const block of blocks)
    if (normalizeText(block.textContent ?? ''))
      block.setAttribute('data-rw-paragraph', String(index++))
  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', BOOK_CSP)
  doc.head.prepend(meta)
  // XMLSerializer writes the HTML namespace itself; a literal HTML xmlns attribute duplicates it.
  doc.documentElement.removeAttribute('xmlns')
  doc.documentElement.setAttributeNS(
    'http://www.w3.org/2000/xmlns/',
    'xmlns:epub',
    'http://www.idpf.org/2007/ops',
  )
  return new XMLSerializer().serializeToString(doc)
}
