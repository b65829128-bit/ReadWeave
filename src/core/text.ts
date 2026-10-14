function splitsPair(text: string, offset: number): boolean {
  const previous = text.charCodeAt(offset - 1)
  const next = text.charCodeAt(offset)
  return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}

/** Offsets and budgets use UTF-16; returned text always ends at a complete code point. */
export function textSlice(
  text: string,
  start: number,
  maximum: number,
): { text: string; start: number } {
  start = Math.min(text.length, Math.max(0, start))
  if (splitsPair(text, start)) start -= 1
  let end = Math.min(text.length, start + maximum)
  if (splitsPair(text, end)) end -= 1
  return { text: text.slice(start, end), start }
}
export function textTail(text: string, maximum: number): { text: string; start: number } {
  let start = Math.max(0, text.length - maximum)
  if (splitsPair(text, start)) start += 1
  return { text: text.slice(start), start }
}
export function validTextOffset(text: string, offset: number): boolean {
  return (
    Number.isInteger(offset) && offset > 0 && offset <= text.length && !splitsPair(text, offset)
  )
}
