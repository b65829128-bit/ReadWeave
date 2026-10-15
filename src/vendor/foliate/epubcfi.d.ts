export function fromRange(
  range: Range,
  filter?: (node: Node) => number,
  cache?: WeakMap<Node, unknown[]>,
): string
export function parse(cfi: string): unknown
export function toRange(doc: Document, parts: unknown): Range
export function collapse(cfi: string, toEnd?: boolean): string
export function compare(a: string, b: string): number
export function joinIndir(base: string, range: unknown): string
