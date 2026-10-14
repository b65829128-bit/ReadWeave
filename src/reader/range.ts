/** Element boundaries are ambiguous in EPUB CFI; anchor textual selections to actual text nodes. */
export function textRange(source: Range): Range {
  if (source.collapsed) return source
  const root = source.commonAncestorContainer
  if (root.nodeType === Node.TEXT_NODE) return source
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let first: Text | null = null
  let last: Text | null = null
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue?.length || !source.intersectsNode(node)) continue
    if (!first) first = node as Text
    last = node as Text
  }
  if (!first || !last) return source
  const range = source.cloneRange()
  range.setStart(first, first === source.startContainer ? source.startOffset : 0)
  range.setEnd(last, last === source.endContainer ? source.endOffset : last.length)
  return range
}
