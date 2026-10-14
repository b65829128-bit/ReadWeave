import type { Annotation, ReadingPoint } from './types'
import { collapse, compare } from '../vendor/foliate/epubcfi.js'

/** Compare locations, never just quotes: the same sentence can occur more than once. */
export function isSamePassage(annotation: Annotation, point: ReadingPoint): boolean {
  return (
    annotation.locator.cfi === point.locator.cfi ||
    (annotation.locator.sectionIndex === point.locator.sectionIndex &&
      annotation.locator.paragraphId === point.locator.paragraphId &&
      annotation.locator.endOffset === point.locator.endOffset &&
      annotation.text === point.text.slice(0, 6000))
  )
}

/** Toggling any part of an existing highlight removes it instead of stacking another layer. */
export function overlapsPassage(annotation: Annotation, point: ReadingPoint): boolean {
  if (isSamePassage(annotation, point)) return true
  if (annotation.locator.sectionIndex !== point.locator.sectionIndex) return false
  try {
    return (
      compare(collapse(annotation.locator.cfi), collapse(point.locator.cfi, true)) < 0 &&
      compare(collapse(point.locator.cfi), collapse(annotation.locator.cfi, true)) < 0
    )
  } catch {
    return false
  }
}
