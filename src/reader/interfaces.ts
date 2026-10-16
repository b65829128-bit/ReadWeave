import type { EPUB } from '../vendor/foliate/epub.js'
import type { Locator, ReadingPoint, Preferences, Paragraph } from '../core/types'

export interface FoliateLocation {
  reason?: string
  cfi: string
  fraction: number
  section: { current: number }
  range: Range
  tocItem?: { label?: string }
}
export interface FoliateView extends HTMLElement {
  book: EPUB
  renderer: {
    setAttribute(name: string, value: string): void
    setStyles(css: string): void
    getContents(): { doc: Document; index: number }[]
    setSelectionLocked?(locked: boolean): void
  }
  lastLocation?: FoliateLocation
  open(book: EPUB): Promise<void>
  init(options: { lastLocation?: string; showTextStart?: boolean }): Promise<void>
  close(): void
  getCFI(index: number, range: Range): string
  goTo(target: string | number): Promise<unknown>
  goToFraction(progress: number): Promise<void>
  prev(): Promise<void>
  next(): Promise<void>
  addAnnotation(annotation: { value: string; color?: string }): Promise<unknown>
  deleteAnnotation(annotation: { value: string }): Promise<unknown>
}
export interface ReaderAdapter {
  capture(): ReadingPoint | null
  navigate(locator: Locator): Promise<void>
  goTo(target: string | number): Promise<void>
  previous(): Promise<void>
  next(): Promise<void>
  setPreferences(preferences: Preferences): void
  getParagraphs(): readonly Paragraph[]
  clearSelection(): void
}
