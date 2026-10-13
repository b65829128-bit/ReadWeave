import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react'
import { View } from '../vendor/foliate/view.js'
import { Overlayer } from '../vendor/foliate/overlayer.js'
import type { Annotation, Locator, Preferences, ReadingPoint } from '../core/types'
import type { FoliateLocation, FoliateView, ReaderAdapter } from './interfaces'
import type { LoadedBook } from './epub'
import { normalizeText } from './sanitize'

interface Props {
  loaded: LoadedBook
  preferences: Preferences
  annotations: Annotation[]
  onPosition: (locator: Locator, chapter: string) => void
  onSelection: (point: ReadingPoint | null) => void
  onReady: () => void
  onError: (error: unknown) => void
}

function readerStyles(preferences: Preferences): string {
  const colors =
    preferences.theme === 'night'
      ? ['#202622', '#dedfd7']
      : preferences.theme === 'sepia'
        ? ['#f0e7d2', '#413b30']
        : ['#fcfbf7', '#333c35']
  return `html { color-scheme: ${preferences.theme === 'night' ? 'dark' : 'light'}; background: ${colors[0]} !important; }
    body { font-family: "Noto Serif SC", "Source Han Serif SC", "Microsoft YaHei", serif !important; font-size: ${preferences.fontSize}px !important; line-height: ${preferences.lineHeight} !important; color: ${colors[1]} !important; background: ${colors[0]} !important; padding: 12px 4px !important; }
    p { margin: 0 0 1.1em; text-align: justify; } h1 { font-size: 1.65em; font-weight: 600; line-height: 1.5; margin: .8em 0 1em; } h2 { font-size: 1.25em; margin: 1.4em 0 .8em; } h3 { font-size: 1.1em; } img { max-width: 100%; max-height: 75vh; object-fit: contain; } a { color: #518270; } blockquote { margin: 1.5em 0; padding: .2em 1em; border-left: 2px solid #9aaf91; opacity: .85; } pre { white-space: pre-wrap; font-size: .85em; } ::selection { background: #c9d8bc; color: #23382b; }`
}

function pointFromRange(
  view: FoliateView,
  loaded: LoadedBook,
  range: Range,
  sectionIndex: number,
  isSelection: boolean,
): ReadingPoint | null {
  const end =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement
  let element = end?.closest('[data-rw-paragraph]')
  if (!element && range.endContainer.nodeType === Node.ELEMENT_NODE) {
    const node = range.endContainer.childNodes[Math.max(0, range.endOffset - 1)]
    const parent = node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement
    element = parent?.matches('[data-rw-paragraph]')
      ? parent
      : [...(parent?.querySelectorAll('[data-rw-paragraph]') ?? [])].at(-1)
  }
  if (!element) return null
  const paragraphId = `p_${sectionIndex}_${element.getAttribute('data-rw-paragraph')}`
  const paragraph = loaded.paragraphs.find((p) => p.id === paragraphId)
  if (!paragraph) return null
  let endOffset = 0
  if (element.contains(range.endContainer)) {
    const prefix = range.cloneRange()
    prefix.setStart(element, 0)
    endOffset = normalizeText(prefix.toString()).length
  } else if (range.intersectsNode(element)) endOffset = paragraph.text.length
  if (!endOffset) return null
  const text = normalizeText(range.toString())
  return {
    text,
    isSelection,
    locator: {
      cfi: view.getCFI(sectionIndex, range),
      sectionIndex,
      paragraphId,
      endOffset,
      progress: view.lastLocation?.fraction ?? 0,
      quote: {
        exact: text.slice(0, 240),
        prefix: paragraph.text.slice(
          Math.max(0, endOffset - text.length - 48),
          Math.max(0, endOffset - text.length),
        ),
        suffix: paragraph.text.slice(endOffset, endOffset + 48),
      },
    },
  }
}

export const Reader = forwardRef<ReaderAdapter, Props>(function Reader(props, ref) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<FoliateView | null>(null)
  const selected = useRef<ReadingPoint | null>(null)
  const callbacks = useRef(props)
  const preferences = useRef(props.preferences)
  const annotationRef = useRef(props.annotations)
  const renderedAnnotations = useRef(props.annotations)
  const loaded = props.loaded
  useEffect(() => {
    callbacks.current = props
    preferences.current = props.preferences
    annotationRef.current = props.annotations
  })

  useImperativeHandle(
    ref,
    () => ({
      capture() {
        if (selected.current) return structuredClone(selected.current)
        const view = viewRef.current
        const location = view?.lastLocation
        return view && location
          ? pointFromRange(view, loaded, location.range, location.section.current, false)
          : null
      },
      async navigate(locator) {
        const view = viewRef.current
        if (!view) throw new Error('阅读器尚未就绪。')
        const result = await view.goTo(locator.cfi)
        if (!result) {
          const exact = locator.quote?.exact
          const candidates = exact ? loaded.paragraphs.filter((p) => p.text.includes(exact)) : []
          if (candidates.length !== 1 || !(await view.goTo(candidates[0].cfi)))
            throw new Error('此位置已失效或存在多个候选，请从目录重新定位。')
        }
      },
      async goTo(target) {
        await viewRef.current?.goTo(target)
      },
      async previous() {
        await viewRef.current?.prev()
      },
      async next() {
        await viewRef.current?.next()
      },
      setPreferences(value) {
        viewRef.current?.renderer?.setStyles(readerStyles(value))
      },
      getParagraphs() {
        return loaded.paragraphs
      },
    }),
    [loaded],
  )

  useEffect(() => {
    const view = new View()
    viewRef.current = view
    view.setAttribute('aria-label', loaded.record.title)
    view.setAttribute('role', 'document')
    host.current?.append(view)
    let disposed = false
    const cleanupDocuments: (() => void)[] = []
    view.addEventListener('external-link', (event) => {
      event.preventDefault()
      callbacks.current.onError(
        new Error('书籍中的外部链接已拦截。需要外部资料时，请单独访问可信来源。'),
      )
    })
    view.addEventListener('load', (event) => {
      const { doc, index } = (event as CustomEvent<{ doc: Document; index: number }>).detail
      const updateSelection = () => {
        const selection = doc.defaultView?.getSelection()
        if (!selection || selection.isCollapsed || !selection.rangeCount) return
        const point = pointFromRange(view, loaded, selection.getRangeAt(0), index, true)
        if (point?.text) {
          selected.current = point
          callbacks.current.onSelection(point)
        }
      }
      const pointerUp = () => {
        const selection = doc.defaultView?.getSelection()
        if (!selection || selection.isCollapsed) {
          selected.current = null
          callbacks.current.onSelection(null)
        } else updateSelection()
      }
      const keydown = (event: KeyboardEvent) => {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          !doc.defaultView?.getSelection()?.isCollapsed
        )
          return
        if (event.key === 'ArrowRight') {
          event.preventDefault()
          void view.next()
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault()
          void view.prev()
        }
      }
      doc.addEventListener('selectionchange', updateSelection)
      doc.addEventListener('pointerup', pointerUp)
      doc.addEventListener('keydown', keydown)
      cleanupDocuments.push(() => {
        doc.removeEventListener('selectionchange', updateSelection)
        doc.removeEventListener('pointerup', pointerUp)
        doc.removeEventListener('keydown', keydown)
      })
    })
    view.addEventListener('relocate', (event) => {
      const location = (event as CustomEvent<FoliateLocation>).detail
      selected.current = null
      callbacks.current.onSelection(null)
      const point = pointFromRange(view, loaded, location.range, location.section.current, false)
      if (point)
        callbacks.current.onPosition(
          point.locator,
          location.tocItem?.label ??
            loaded.paragraphs.find((p) => p.id === point.locator.paragraphId)?.chapter ??
            '',
        )
    })
    view.addEventListener('draw-annotation', (event) => {
      const { draw, annotation } = (
        event as CustomEvent<{
          draw: (draw: typeof Overlayer.highlight, options: { color: string }) => void
          annotation: { color?: string }
        }>
      ).detail
      draw(Overlayer.highlight, { color: annotation.color ?? '#e0cc7b' })
    })
    view.addEventListener('create-overlay', () => {
      for (const annotation of annotationRef.current.filter(
        (a) => a.kind === 'highlight' || a.kind === 'note',
      ))
        void view.addAnnotation({ value: annotation.locator.cfi, color: '#dfc86e' })
    })
    void (async () => {
      await view.open(loaded.book)
      if (disposed) {
        view.close()
        return
      }
      view.renderer.setAttribute('flow', 'paginated')
      view.renderer.setAttribute('max-column-count', '1')
      view.renderer.setAttribute('max-inline-size', '760px')
      view.renderer.setAttribute('gap', '8%')
      view.renderer.setAttribute('margin', '20px')
      view.renderer.setStyles(readerStyles(preferences.current))
      await view.init({
        lastLocation: loaded.record.position?.cfi,
        showTextStart: !loaded.record.position,
      })
      if (!disposed) callbacks.current.onReady()
    })().catch((error) => {
      if (!disposed) callbacks.current.onError(error)
    })
    return () => {
      disposed = true
      for (const cleanup of cleanupDocuments) cleanup()
      view.close()
      view.remove()
      if (viewRef.current === view) viewRef.current = null
    }
  }, [loaded])

  useEffect(() => {
    viewRef.current?.renderer?.setStyles(readerStyles(props.preferences))
  }, [props.preferences])
  useEffect(() => {
    const view = viewRef.current
    if (!view?.renderer) return
    const live = new Set(
      props.annotations
        .filter((a) => a.kind === 'highlight' || a.kind === 'note')
        .map((a) => a.locator.cfi),
    )
    for (const previous of renderedAnnotations.current)
      if (!live.has(previous.locator.cfi))
        void view.deleteAnnotation({ value: previous.locator.cfi })
    for (const value of live) void view.addAnnotation({ value, color: '#dfc86e' })
    renderedAnnotations.current = props.annotations
  }, [props.annotations])
  return <div className="reader-surface" ref={host} />
})
