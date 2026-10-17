import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import {
  ArrowLeft,
  BookOpen,
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  FolderOpen,
  Highlighter,
  LibraryBig,
  List,
  LockKeyhole,
  Maximize,
  Minimize,
  NotebookPen,
  Puzzle,
  Search,
  Settings2,
  Sparkles,
  Type,
  X,
} from 'lucide-react'
import { isTauri } from '@tauri-apps/api/core'
import { Library } from './components/Library'
import { Modal } from './components/Modal'
import { Appearance, SettingsDialog } from './components/Settings'
import { ActionPacks } from './components/ActionPacks'
import { Notebook } from './components/Notebook'
import { AssistantPanel } from './components/AssistantPanel'
import { Answer } from './components/Answer'
import { ModelActivity } from './components/ModelActivity'
import { Reader } from './reader/Reader'
import { BookNotes, PassageNotes } from './components/BookNotes'
import { isSamePassage, overlapsPassage } from './core/annotations'
import { requestReaderFullscreen } from './reader/fullscreen'
import { openEpub, type LoadedBook } from './reader/epub'
import type { ReaderAdapter } from './reader/interfaces'
import { storage, download } from './core/storage'
import {
  defaultModel,
  defaultPreferences,
  type Annotation,
  type BookRecord,
  type Conversation,
  type Fragment,
  type Locator,
  type Message,
  type Preferences,
  type ReadingPoint,
  type Snapshot,
} from './core/types'
import {
  defaultPack,
  parsePack,
  renderAction,
  type ActionPack,
  type InstalledPack,
  type ReadingAction,
} from './core/plugins'
import { readingService } from './core/reading-service'
import {
  createBackup,
  exportMarkdown,
  modelSettingsSchema,
  parseBackup,
  preferencesSchema,
  restoreBackup,
  type Backup,
} from './core/backup'
import { createAssistantRuntime } from './harness'

type Screen = 'library' | 'reader' | 'notes' | 'actions'
const scopeLabels = { 'to-position': '截至提问位置', chapter: '当前章节', book: '整本书' }
const uniqueId = () => crypto.randomUUID()

function allowsKeylessModelEndpoint(endpoint: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`brand ${compact ? 'brand-compact' : ''}`}>
      <span className="brand-mark">
        <BookOpen size={24} strokeWidth={1.6} />
      </span>
      <div>
        <strong>
          ReadWeave<span> / </span>
        </strong>
        {!compact && <small>让理解留在阅读里</small>}
      </div>
    </div>
  )
}

export default function App() {
  const [screen, setScreen] = useState<Screen>('library')
  const [books, setBooks] = useState<BookRecord[]>([])
  const [annotations, setAnnotations] = useState<Annotation[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [packs, setPacks] = useState<InstalledPack[]>([])
  const [preferences, setPreferences] = useState(defaultPreferences)
  const [model, setModel] = useState(defaultModel)
  const [apiKey, setApiKey] = useState('')
  const [astrbotApiKey, setAstrbotApiKey] = useState('')
  const [hasApiKey, setHasApiKey] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [loaded, setLoaded] = useState<LoadedBook | null>(null)
  const [loading, setLoading] = useState('正在整理你的书架…')
  const [readerReady, setReaderReady] = useState(false)
  const [position, setPosition] = useState<Locator | null>(null)
  const [chapter, setChapter] = useState('')
  const [selection, setSelection] = useState<ReadingPoint | null>(null)
  const [showAssistant, setShowAssistant] = useState(true)
  const [showToc, setShowToc] = useState(false)
  const [showBookNotes, setShowBookNotes] = useState(false)
  const [annotationPoint, setAnnotationPoint] = useState<ReadingPoint | null>(null)
  const [immersive, setImmersive] = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  const [showAppearance, setShowAppearance] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [panelHeight, setPanelHeight] = useState(55)
  const [toast, setToast] = useState('')
  const [noteDraft, setNoteDraft] = useState<{
    point: ReadingPoint
    text: string
    annotationId?: string
  } | null>(null)
  const [packPreview, setPackPreview] = useState<ActionPack | null>(null)
  const [packToDelete, setPackToDelete] = useState<InstalledPack | null>(null)
  const [restorePreview, setRestorePreview] = useState<Backup | null>(null)
  const [archiveConversation, setArchiveConversation] = useState<Conversation | null>(null)
  const [citation, setCitation] = useState<{
    fragment: Fragment
    bookId: string
    bookVersion: string
  } | null>(null)
  const [draft, setDraft] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [showBookSearch, setShowBookSearch] = useState(false)
  const reader = useRef<ReaderAdapter>(null)
  const bookOpenGeneration = useRef(0)
  const bookOpenController = useRef<AbortController | null>(null)
  const openedBook = useRef<LoadedBook | null>(null)
  const grants = useRef(new Set<string>())
  const fileInput = useRef<HTMLInputElement>(null)
  const packInput = useRef<HTMLInputElement>(null)
  const backupInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(true)
  const releaseFullscreen = useRef<(() => Promise<void>) | null>(null)
  const immersiveRef = useRef(false)
  const previousPanels = useRef({ toc: false, assistant: true })
  const annotationWrites = useRef(new Set<string>())

  const notify = useCallback((error: unknown) => {
    setToast(error instanceof Error ? error.message : String(error))
  }, [])
  const [taskRuntime] = useState(() =>
    createAssistantRuntime({
      save: (item) => storage.put('conversations', item.id, item),
      onSaved: (item) => {
        if (mounted.current)
          setConversations((all) => [...all.filter((c) => c.id !== item.id), item])
      },
      onError: (error) => {
        if (mounted.current) notify(error)
      },
    }),
  )
  const {
    phase,
    conversation,
    pending,
    status: runStatus,
  } = useSyncExternalStore(taskRuntime.subscribe, taskRuntime.getSnapshot, taskRuntime.getSnapshot)
  const running = phase === 'running'
  const preparing = phase === 'preparing'
  const currentRunId = conversation?.messages.at(-1)?.run?.id
  useEffect(() => {
    if (currentRunId) setDraft('')
  }, [currentRunId])
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 7000)
      return () => clearTimeout(timer)
    }
  }, [toast])
  useEffect(() => {
    document.documentElement.dataset.theme = preferences.theme
  }, [preferences.theme])

  const refreshData = async () => {
    const [nextBooks, nextAnnotations, nextConversations, nextPacks] = await Promise.all([
      storage.list<BookRecord>('books'),
      storage.list<Annotation>('annotations'),
      storage.list<Conversation>('conversations'),
      storage.list<InstalledPack>('packs'),
    ])
    setBooks(nextBooks)
    setAnnotations(nextAnnotations)
    setConversations(nextConversations)
    setPacks(nextPacks)
  }

  useEffect(() => {
    mounted.current = true
    void (async () => {
      const hasCredential = storage.credentialHas().catch((error) => {
        notify(error instanceof Error ? error : '无法读取系统安全凭据。')
        return false
      })
      const [savedPreferences, savedModel, seeded, savedCredential] = await Promise.all([
        storage.get('settings', 'preferences'),
        storage.get('settings', 'model'),
        storage.get('settings', 'initialized'),
        hasCredential,
      ])
      const nextPreferences = preferencesSchema.safeParse(savedPreferences)
      const nextModel = modelSettingsSchema.safeParse(savedModel)
      const initialPreferences = nextPreferences.success ? nextPreferences.data : defaultPreferences
      const initialModel = nextModel.success ? nextModel.data : defaultModel
      setPreferences(initialPreferences)
      setModel(initialModel)
      taskRuntime.configureHarness(initialModel.harness ?? 'builtin', initialModel.enabled)
      setHasApiKey(savedCredential)
      setConfigured(
        initialModel.harness !== 'astrbot' &&
          (savedCredential || allowsKeylessModelEndpoint(initialModel.endpoint)),
      )
      await storage.put('settings', 'preferences', initialPreferences)
      await storage.put('settings', 'model', initialModel)
      if (!seeded) {
        setLoading('正在准备两本离线示例书…')
        for (const [index, fileName] of ['gradient.epub', 'understanding.epub'].entries()) {
          const response = await fetch(`${import.meta.env.BASE_URL}samples/${fileName}`)
          if (!response.ok) throw new Error('示例书加载失败，请尝试导入自己的 EPUB。')
          const blob = await response.blob()
          const sample = await openEpub(blob, fileName)
          const record = { ...sample.record, isSample: true, coverTone: index === 0 ? 1 : 0 }
          sample.book.destroy()
          const existing = await storage.get<BookRecord>('books', record.id)
          if (!existing) {
            await storage.putBlob(record.id, blob)
            await storage.put('books', record.id, record)
          }
        }
        await storage.put('packs', defaultPack.id, {
          id: defaultPack.id,
          manifest: defaultPack,
          enabled: true,
          installedAt: new Date().toISOString(),
        } satisfies InstalledPack)
        await storage.put('settings', 'initialized', true)
      }
    })()
      .catch(notify)
      .finally(async () => {
        if (mounted.current) {
          await refreshData().catch(notify)
          setLoading('')
        }
      })
    return () => {
      mounted.current = false
      bookOpenGeneration.current += 1
      bookOpenController.current?.abort()
      taskRuntime.cancel()
      openedBook.current?.book.destroy()
    }
  }, [notify, taskRuntime])

  const cancel = () => {
    taskRuntime.cancel()
  }
  const dismissPreview = () => {
    taskRuntime.cancel()
  }
  const newTopic = () => {
    taskRuntime.reset()
    setDraft('')
  }
  const exitImmersive = useCallback(() => {
    immersiveRef.current = false
    setImmersive(false)
    setControlsVisible(true)
    setShowToc(previousPanels.current.toc)
    setShowAssistant(previousPanels.current.assistant)
    const release = releaseFullscreen.current
    releaseFullscreen.current = null
    void release?.().catch(notify)
  }, [notify])
  const hideControls = () => {
    setShowToc(false)
    setShowAssistant(false)
    setShowBookNotes(false)
    setAnnotationPoint(null)
    setControlsVisible(false)
  }
  const enterImmersive = async () => {
    previousPanels.current = { toc: showToc, assistant: showAssistant }
    immersiveRef.current = true
    setImmersive(true)
    reader.current?.clearSelection()
    hideControls()
    try {
      const release = await requestReaderFullscreen()
      if (immersiveRef.current) releaseFullscreen.current = release
      else await release()
    } catch {
      notify('已进入沉浸阅读。系统全屏暂不可用，点击正文中间可唤醒控件。')
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as Element | null
      if (
        document.querySelector('dialog[open]') ||
        target?.closest('input, textarea, select, [contenteditable="true"]')
      )
        return
      if (event.key === 'Escape' && immersiveRef.current) exitImmersive()
      if (
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey &&
        reader.current &&
        !reader.current.capture()?.isSelection
      ) {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault()
          void (
            event.key === 'ArrowRight' ? reader.current.next() : reader.current.previous()
          ).catch(notify)
        }
      }
    }
    const onFullscreen = () => {
      if (!document.fullscreenElement && immersiveRef.current) exitImmersive()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFullscreen)
    }
  }, [exitImmersive, notify])
  const changeScreen = (next: Screen) => {
    if (screen === 'reader' && next !== 'reader') cancel()
    if (next !== 'reader') {
      bookOpenGeneration.current += 1
      bookOpenController.current?.abort()
      bookOpenController.current = null
      setLoading('')
    }
    if (immersiveRef.current && next !== 'reader') exitImmersive()
    setScreen(next)
    setSelection(null)
  }

  const savePreferences = (next: Preferences) => {
    const parsed = preferencesSchema.parse(next)
    if (parsed.scope !== preferences.scope) {
      newTopic()
      grants.current.clear()
    }
    setPreferences(parsed)
    void storage.put('settings', 'preferences', parsed).catch(notify)
  }
  const openBook = async (record: BookRecord, locator?: Locator, prepared?: LoadedBook) => {
    cancel()
    bookOpenController.current?.abort()
    const controller = new AbortController()
    bookOpenController.current = controller
    const generation = ++bookOpenGeneration.current
    setLoading('正在打开书籍…')
    setReaderReady(false)
    let next: LoadedBook | null = null
    try {
      const nextRecord = {
        ...record,
        ...(locator ? { position: locator } : {}),
      }
      // Keep only the current validated book. Returning from the library reuses
      // its immutable content while taking progress and metadata from the record.
      const cached = prepared ?? openedBook.current
      if (cached?.record.id === record.id && cached.record.version === record.version) {
        next = { ...cached, record: nextRecord }
      } else {
        const blob = await storage.getBlob(record.id)
        controller.signal.throwIfAborted()
        if (!blob)
          throw new Error('原书尚未恢复。请重新导入相同版本的 EPUB，笔记和进度会自动关联。')
        next = await openEpub(blob, record.fileName, nextRecord, controller.signal)
      }
      await readingService.register(next.record, next.paragraphs)
      if (!mounted.current || bookOpenGeneration.current !== generation) return false
      const old = openedBook.current
      openedBook.current = next
      setLoaded(next)
      setPosition(locator ?? record.position ?? null)
      setSelection(null)
      taskRuntime.reset()
      setDraft('')
      setScreen('reader')
      setLoading('正在排版…')
      setShowToc(window.innerWidth >= 1200)
      setShowBookNotes(false)
      setAnnotationPoint(null)
      if (old && old.book !== next.book) setTimeout(() => old.book.destroy(), 100)
      return true
    } catch (error) {
      if (mounted.current && bookOpenGeneration.current === generation) {
        setLoading('')
        if (!controller.signal.aborted) notify(error)
      }
      return false
    } finally {
      if (next && openedBook.current?.book !== next.book) next.book.destroy()
      if (bookOpenController.current === controller) bookOpenController.current = null
    }
  }
  const importBook = async (file: File) => {
    cancel()
    bookOpenController.current?.abort()
    const controller = new AbortController()
    bookOpenController.current = controller
    const generation = ++bookOpenGeneration.current
    setLoading('正在校验和导入 EPUB…')
    let next: LoadedBook | null = null
    try {
      next = await openEpub(file, file.name, undefined, controller.signal)
      const previous = await storage.get<BookRecord>('books', next.record.id)
      controller.signal.throwIfAborted()
      const record = previous ?? next.record
      await storage.putBlob(record.id, file)
      await storage.put('books', record.id, record)
      if (!mounted.current || bookOpenGeneration.current !== generation) return
      await refreshData()
      if (bookOpenGeneration.current !== generation) return
      if (await openBook(record, undefined, next))
        notify(previous ? '这本书已在书架中，已恢复上次的位置。' : '书籍已导入，开始阅读吧。')
    } catch (error) {
      if (mounted.current && bookOpenGeneration.current === generation) {
        setLoading('')
        if (!controller.signal.aborted) notify(error)
      }
    } finally {
      if (next && openedBook.current?.book !== next.book) next.book.destroy()
      if (bookOpenController.current === controller) bookOpenController.current = null
    }
  }
  const onPosition = (locator: Locator, label: string) => {
    if (!loaded) return
    setPosition(locator)
    setChapter(label)
    setAnnotationPoint(null)
    const record = { ...loaded.record, position: locator, lastOpenedAt: new Date().toISOString() }
    setBooks((current) => current.map((book) => (book.id === record.id ? record : book)))
    void storage.put('books', record.id, record).catch(notify)
  }
  const capture = (): ReadingPoint | null => {
    const point = reader.current?.capture()
    if (!point) {
      notify('阅读位置尚未就绪，请在正文出现后重试。')
      return null
    }
    return point
  }
  const saveAnnotation = async (kind: Annotation['kind'], point?: ReadingPoint, note = '') => {
    const current = point ?? capture()
    if (!current || !loaded) return
    const writeKey = `${kind}:${current.locator.cfi}`
    if (annotationWrites.current.has(writeKey)) return
    annotationWrites.current.add(writeKey)
    try {
      const existing = annotations.filter(
        (item) =>
          item.bookId === loaded.record.id &&
          item.bookVersion === loaded.record.version &&
          item.kind === kind &&
          (kind === 'highlight' ? overlapsPassage(item, current) : isSamePassage(item, current)),
      )
      if ((kind === 'highlight' || kind === 'bookmark') && existing.length) {
        for (const item of existing) await storage.remove('annotations', item.id)
        const ids = new Set(existing.map((item) => item.id))
        setAnnotations((all) => all.filter((item) => !ids.has(item.id)))
        notify(kind === 'highlight' ? '已取消高亮。' : '已取消书签。')
        return
      }
      const annotation: Annotation = {
        id: uniqueId(),
        bookId: loaded.record.id,
        bookVersion: loaded.record.version,
        kind,
        text: current.text.slice(0, 6000),
        note,
        chapter:
          loaded.paragraphs.find((p) => p.id === current.locator.paragraphId)?.chapter ?? chapter,
        locator: current.locator,
        createdAt: new Date().toISOString(),
      }
      await storage.put('annotations', annotation.id, annotation)
      setAnnotations((current) => [...current, annotation])
      notify(
        kind === 'bookmark'
          ? '书签已保存。'
          : kind === 'highlight'
            ? '高亮已保存。'
            : '笔记已保存。',
      )
    } finally {
      annotationWrites.current.delete(writeKey)
    }
  }
  const removeAnnotation = async (annotation: Annotation) => {
    await storage.remove('annotations', annotation.id)
    setAnnotations((all) => all.filter((item) => item.id !== annotation.id))
  }
  const editNote = (point: ReadingPoint, annotation?: Annotation) => {
    setNoteDraft({ point, text: annotation?.note ?? '', annotationId: annotation?.id })
  }
  const saveAnswer = async (message: Message) => {
    if (!conversation || !loaded) return
    await saveAnnotation(
      'note',
      {
        locator: conversation.snapshot.locator,
        text: conversation.snapshot.selection || conversation.snapshot.initial.at(-1)?.text || '',
        isSelection: !!conversation.snapshot.selection,
      },
      message.content,
    )
  }
  const grantKey = (snapshot: Snapshot) =>
    JSON.stringify([
      taskRuntime.harnesses.selectedId,
      taskRuntime.providers.selectedId,
      model.endpoint,
      model.model,
      model.astrbotEndpoint,
      snapshot.bookVersion,
      snapshot.scope,
    ])
  const ask = async (question: string) => {
    if (!question.trim() || phase !== 'idle' || !loaded) return
    setDraft(question)
    setShowAssistant(true)
    setControlsVisible(true)
    if (!configured || !model.enabled) {
      setShowSettings(true)
      if (!model.enabled) notify('阅读伙伴已停用，可在设置中重新启用。')
      return
    }
    const source = loaded
    const point = capture()
    if (!point) return
    await taskRuntime.prepare({
      bookId: source.record.id,
      bookVersion: source.record.version,
      scope: preferences.scope,
      question,
      settings: model,
      apiKey: model.harness === 'astrbot' ? astrbotApiKey : apiKey,
      createTask: (signal) =>
        readingService.create(source.record, source.paragraphs, point, preferences.scope, signal),
      isApproved: (snapshot) => grants.current.has(grantKey(snapshot)),
    })
  }
  const askAction = (action: ReadingAction) =>
    ask(
      renderAction(action, {
        selection: selection?.text ?? '',
        title: loaded?.record.title ?? '',
        chapter,
        question: draft,
      }),
    )

  const installPack = async () => {
    if (!packPreview) return
    const previous = packs.find((pack) => pack.id === packPreview.id)
    const installed: InstalledPack = {
      id: packPreview.id,
      manifest: packPreview,
      enabled: previous?.enabled ?? true,
      installedAt: new Date().toISOString(),
      ...(previous ? { previous: previous.manifest } : {}),
    }
    await storage.put('packs', installed.id, installed)
    setPacks((current) => [...current.filter((pack) => pack.id !== installed.id), installed])
    setPackPreview(null)
    notify(previous ? '动作包已更新，可回滚到上一版本。' : '动作包已安装。')
  }
  const updatePack = async (pack: InstalledPack) => {
    setPacks((current) => current.map((item) => (item.id === pack.id ? pack : item)))
    try {
      await storage.put('packs', pack.id, pack)
    } catch (error) {
      await refreshData()
      throw error
    }
  }
  const exportNotes = () =>
    download(
      `ReadWeave-notes-${new Date().toISOString().slice(0, 10)}.md`,
      exportMarkdown(
        annotations,
        conversations,
        (id) => books.find((book) => book.id === id)?.title ?? '未导入的书籍',
      ),
      'text/markdown;charset=utf-8',
    )
  const exportBackup = async (includeOriginals: boolean) => {
    download(
      `ReadWeave-backup-${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(await createBackup(includeOriginals), null, 2),
      'application/json',
    )
    notify('备份已导出，不包含服务密钥。')
  }
  const showCitation = (fragment: Fragment, source = conversation) => {
    if (source)
      setCitation({ fragment, bookId: source.bookId, bookVersion: source.snapshot.bookVersion })
  }
  const navigateCitation = async () => {
    if (!citation) return
    let temporary: LoadedBook | null = null
    try {
      const record = books.find((book) => book.id === citation.bookId)
      if (!record || record.version !== citation.bookVersion)
        throw new Error('引用对应的书籍版本不可用。')
      let target = loaded
      if (!target || target.record.id !== record.id) {
        const blob = await storage.getBlob(record.id)
        if (!blob) throw new Error('请先重新导入此书的原始 EPUB。')
        temporary = await openEpub(blob, record.fileName, record)
        target = temporary
      }
      await readingService.register(target.record, target.paragraphs)
      let locator =
        (await taskRuntime.resolveAnchor(record.id, record.version, citation.fragment)) ??
        (await readingService.resolveAnchor(record.id, record.version, citation.fragment))
      if (!locator) {
        const matches = target.paragraphs.filter((p) => p.text.includes(citation.fragment.text))
        if (matches.length !== 1)
          throw new Error('引用存在多个候选或已经失效。原文仍可在此查看，未自动跳转。')
        const match = matches[0]
        locator = {
          cfi: match.cfi,
          sectionIndex: match.sectionIndex,
          paragraphId: match.id,
          endOffset: match.text.indexOf(citation.fragment.text) + citation.fragment.text.length,
          progress: 0,
          quote: { exact: citation.fragment.text.slice(0, 240), prefix: '', suffix: '' },
        }
      }
      if (loaded?.record.id === record.id && screen === 'reader')
        await reader.current?.navigate(locator)
      else await openBook(record, locator, temporary ?? undefined)
      temporary = null
      setCitation(null)
      setArchiveConversation(null)
    } catch (error) {
      notify(error)
    } finally {
      temporary?.book.destroy()
    }
  }

  const activeAnnotations = loaded
    ? annotations.filter(
        (annotation) =>
          annotation.bookId === loaded.record.id &&
          annotation.bookVersion === loaded.record.version,
      )
    : []
  const actions = packs
    .filter((pack) => pack.enabled)
    .flatMap((pack) =>
      pack.manifest.actions.map((action) => ({ ...action, id: `${pack.id}:${action.id}` })),
    )
  const reading = screen === 'reader' && loaded
  const selectedHighlight =
    selection &&
    activeAnnotations.some((item) => item.kind === 'highlight' && overlapsPassage(item, selection))
  const passageAnnotations = annotationPoint
    ? activeAnnotations.filter((item) => isSamePassage(item, annotationPoint))
    : []
  const bookSearchResults =
    loaded && searchTerm.trim()
      ? loaded.paragraphs
          .filter((p) => p.text.toLowerCase().includes(searchTerm.trim().toLowerCase()))
          .slice(0, 30)
      : []

  return (
    <div
      className={`app ${reading ? 'in-reader' : ''} ${immersive ? 'immersive' : ''} ${immersive && controlsVisible ? 'controls-awake' : ''}`}
      style={{ '--panel-height': `${panelHeight}dvh` } as CSSProperties}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".epub,application/epub+zip"
        hidden
        aria-label="导入 EPUB 文件"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void importBook(file)
        }}
      />
      <input
        ref={packInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file)
            void (async () => {
              if (file.size > 256 * 1024) throw new Error('动作包超过 256 KB。')
              setPackPreview(parsePack(await file.text()))
            })().catch(notify)
        }}
      />
      <input
        ref={backupInput}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file)
            void (async () => {
              if (file.size > 64 * 1024 * 1024) throw new Error('备份超过 64 MB。')
              setRestorePreview(parseBackup(await file.text()))
            })().catch(notify)
        }}
      />
      {!reading ? (
        <>
          <aside className="app-sidebar">
            <Brand />
            <nav aria-label="主导航">
              {(
                [
                  { id: 'library', label: '我的书架', icon: LibraryBig },
                  { id: 'notes', label: '阅读笔记', icon: NotebookPen },
                  { id: 'actions', label: '阅读动作', icon: Puzzle },
                ] as const
              ).map((item) => (
                <button
                  key={item.id}
                  className={screen === item.id ? 'active' : ''}
                  onClick={() => changeScreen(item.id)}
                >
                  <item.icon size={19} />
                  {item.label}
                  {item.id === 'library' && <span>{books.length}</span>}
                </button>
              ))}
            </nav>
            <div className="sidebar-bottom">
              <div className="local-status">
                <span>
                  <LockKeyhole size={17} />
                </span>
                <div>
                  <strong>本地优先，安心阅读</strong>
                  <small>你的书和笔记留在设备上</small>
                </div>
              </div>
              <button onClick={() => setShowSettings(true)}>
                <Settings2 size={18} />
                设置
              </button>
              <button onClick={() => setShowAbout(true)}>
                <CircleHelp size={18} />
                关于 ReadWeave <small>α 0.1</small>
              </button>
            </div>
          </aside>
          <main className="app-main">
            <header className="library-header">
              <span>
                <FolderOpen size={16} />
                {screen === 'library' ? '我的书架' : screen === 'notes' ? '阅读笔记' : '阅读动作'}
              </span>
              <div>
                <span className="local-badge">
                  <i />
                  本地阅读空间
                </span>
                <button
                  className="icon-button"
                  onClick={() => setShowSettings(true)}
                  aria-label="打开设置"
                >
                  <Settings2 size={18} />
                </button>
              </div>
            </header>
            {screen === 'library' && (
              <Library
                books={books}
                loading={loading}
                onOpen={(record) => {
                  void openBook(record)
                }}
                onImport={() => fileInput.current?.click()}
              />
            )}
            {screen === 'actions' && (
              <ActionPacks
                packs={packs}
                onImport={() => packInput.current?.click()}
                onToggle={(pack) => {
                  void updatePack({ ...pack, enabled: !pack.enabled }).catch(notify)
                }}
                onExport={(pack) =>
                  download(
                    `${pack.id}.json`,
                    JSON.stringify(pack.manifest, null, 2),
                    'application/json',
                  )
                }
                onRemove={setPackToDelete}
                onRollback={(pack) => {
                  if (pack.previous)
                    void updatePack({ ...pack, manifest: pack.previous, previous: pack.manifest })
                      .then(() => notify('已回滚动作包。'))
                      .catch(notify)
                }}
              />
            )}
            {screen === 'notes' && (
              <Notebook
                books={books}
                annotations={annotations}
                conversations={conversations}
                onLocate={(annotation) => {
                  const book = books.find((book) => book.id === annotation.bookId)
                  if (book && book.version === annotation.bookVersion)
                    void openBook(book, annotation.locator)
                  else notify('此标注对应的书籍版本不可用。')
                }}
                onRemove={(annotation) => {
                  void storage
                    .remove('annotations', annotation.id)
                    .then(() =>
                      setAnnotations((current) =>
                        current.filter((item) => item.id !== annotation.id),
                      ),
                    )
                    .catch(notify)
                }}
                onConversation={setArchiveConversation}
                onExport={exportNotes}
              />
            )}
          </main>
        </>
      ) : (
        <>
          {(!immersive || controlsVisible) && (
            <header className="reader-header">
              <div className="reader-header-left">
                <button
                  className="icon-button"
                  onClick={() => changeScreen('library')}
                  aria-label="返回书架"
                >
                  <ArrowLeft size={20} />
                </button>
                <Brand compact />
                <span className="header-divider" />
                <span className="reader-title">{loaded.record.title}</span>
                <span className="reader-author">{loaded.record.author}</span>
              </div>
              <div className="reader-toolbar">
                <button
                  className={`icon-button toc-toggle ${showToc ? 'active' : ''}`}
                  onClick={() => setShowToc(!showToc)}
                  aria-label="显示目录"
                  aria-expanded={showToc}
                >
                  <List size={20} />
                </button>
                <button
                  className={`icon-button ${showBookNotes ? 'active' : ''}`}
                  aria-label="本书标注"
                  aria-expanded={showBookNotes}
                  onClick={() => setShowBookNotes(!showBookNotes)}
                >
                  <NotebookPen size={19} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setShowBookSearch(true)}
                  aria-label="搜索书内原文"
                >
                  <Search size={19} />
                </button>
                <button
                  className="icon-button"
                  onClick={() => setShowAppearance(true)}
                  aria-label="阅读排版"
                >
                  <Type size={20} />
                </button>
                <button
                  className="icon-button"
                  disabled={!readerReady}
                  onClick={() => {
                    void saveAnnotation('bookmark').catch(notify)
                  }}
                  aria-label="添加书签"
                >
                  <Bookmark size={19} />
                </button>
                <span className="header-divider" />
                <button
                  className="icon-button"
                  aria-label={immersive ? '退出全屏阅读' : '全屏阅读'}
                  onClick={() => {
                    if (immersive) exitImmersive()
                    else void enterImmersive()
                  }}
                >
                  {immersive ? <Minimize size={19} /> : <Maximize size={19} />}
                </button>
                {immersive && (
                  <button className="text-button" onClick={hideControls}>
                    继续沉浸
                  </button>
                )}
                <button
                  aria-label="阅读伙伴"
                  className={`button companion-toggle ${showAssistant ? 'selected' : ''}`}
                  onClick={() => setShowAssistant(!showAssistant)}
                >
                  <Sparkles size={17} />
                  <span>阅读伙伴</span>
                </button>
              </div>
            </header>
          )}
          <div
            className={`reading-layout ${showAssistant ? 'with-assistant' : ''} ${showToc ? 'toc-open' : ''}`}
          >
            {immersive && !controlsVisible && (
              <button className="wake-reader" onClick={() => setControlsVisible(true)}>
                显示阅读控件
              </button>
            )}
            {showToc && (
              <aside className="toc-panel" aria-label="书籍目录">
                <div className="toc-heading">
                  <h2>目录</h2>
                  <span>{loaded.book.sections.length} 个章节</span>
                  <button
                    className="icon-button"
                    onClick={() => setShowToc(false)}
                    aria-label="收起目录"
                  >
                    <X size={17} />
                  </button>
                </div>
                <nav>
                  {(loaded.book.toc ?? []).map((item, i) => (
                    <div key={`${item.href}-${i}`}>
                      <button
                        className={chapter === item.label ? 'active' : ''}
                        onClick={() => {
                          void reader.current?.goTo(item.href)
                          setShowToc(false)
                        }}
                      >
                        <span>{String(i + 1).padStart(2, '0')}</span>
                        {item.label}
                      </button>
                      {item.subitems?.map((subitem) => (
                        <button
                          className="toc-subitem"
                          key={subitem.href}
                          onClick={() => {
                            void reader.current?.goTo(subitem.href)
                            setShowToc(false)
                          }}
                        >
                          {subitem.label}
                        </button>
                      ))}
                    </div>
                  ))}
                </nav>
                <div className="toc-bottom">
                  <BookOpen size={21} />
                  <strong>慢慢读，读进去。</strong>
                  <p>每一次停留，都有意义。</p>
                  <div className="toc-progress">
                    <span style={{ width: `${(position?.progress ?? 0) * 100}%` }} />
                  </div>
                  <span>已读 {Math.round((position?.progress ?? 0) * 100)}%</span>
                  <button
                    className="text-button"
                    onClick={() => {
                      setShowBookNotes(true)
                      setShowToc(false)
                    }}
                  >
                    <NotebookPen size={15} />
                    本书已保存 {activeAnnotations.length} 条标注
                  </button>
                </div>
              </aside>
            )}
            <main className="reading-main">
              <div className="reading-caption">
                <span>{loaded.record.title}</span>
                <span>{loaded.record.isSample ? '原创阅读示例' : 'EPUB'}</span>
              </div>
              <div className="reader-host">
                <Reader
                  ref={reader}
                  loaded={loaded}
                  preferences={preferences}
                  annotations={activeAnnotations}
                  onPosition={onPosition}
                  onSelection={(point) => {
                    setSelection(point)
                    if (point) setAnnotationPoint(null)
                  }}
                  onAnnotation={(point) => {
                    setAnnotationPoint(point)
                    setSelection(null)
                  }}
                  onTap={(area) => {
                    if (area === 'previous') void reader.current?.previous()
                    else if (area === 'next') void reader.current?.next()
                    else if (annotationPoint) setAnnotationPoint(null)
                    else if (immersive) {
                      if (controlsVisible) hideControls()
                      else setControlsVisible(true)
                    }
                  }}
                  onEscape={() => {
                    if (immersive) exitImmersive()
                    else {
                      setAnnotationPoint(null)
                      reader.current?.clearSelection()
                    }
                  }}
                  onReady={() => {
                    setReaderReady(true)
                    setLoading('')
                  }}
                  onError={(error) => {
                    setLoading('')
                    notify(error)
                  }}
                />
                {!readerReady && (
                  <div className="reader-loading">
                    <span className="spinner" />
                    {loading || '正在打开正文…'}
                  </div>
                )}
              </div>
              {showBookNotes && (
                <BookNotes
                  annotations={activeAnnotations}
                  onClose={() => setShowBookNotes(false)}
                  onLocate={(annotation) => {
                    void reader.current
                      ?.navigate(annotation.locator)
                      .then(() => {
                        setShowBookNotes(false)
                        setAnnotationPoint({
                          locator: annotation.locator,
                          text: annotation.text,
                          isSelection: true,
                        })
                      })
                      .catch(notify)
                  }}
                />
              )}
              {annotationPoint && (
                <PassageNotes
                  point={annotationPoint}
                  annotations={passageAnnotations}
                  onClose={() => setAnnotationPoint(null)}
                  onHighlight={() => {
                    void saveAnnotation('highlight', annotationPoint).catch(notify)
                  }}
                  onEdit={(annotation) => editNote(annotationPoint, annotation)}
                  onRemove={(annotation) => {
                    void removeAnnotation(annotation).catch(notify)
                  }}
                />
              )}
              {selection && (
                <div className="selection-toolbar">
                  <span>已选 {selection.text.length} 字</span>
                  <button
                    onClick={() => {
                      setShowAssistant(true)
                      setControlsVisible(true)
                      setDraft('请解释这段内容。')
                    }}
                  >
                    <Sparkles size={15} />
                    提问
                  </button>
                  <button
                    onClick={() => {
                      void saveAnnotation('highlight', selection).catch(notify)
                    }}
                  >
                    <Highlighter size={15} />
                    {selectedHighlight ? '取消高亮' : '高亮'}
                  </button>
                  <button
                    onClick={() =>
                      editNote(
                        selection,
                        activeAnnotations.find(
                          (item) => item.kind === 'note' && isSamePassage(item, selection),
                        ),
                      )
                    }
                  >
                    <NotebookPen size={15} />
                    笔记
                  </button>
                  <button aria-label="取消选文" onClick={() => reader.current?.clearSelection()}>
                    <X size={15} />
                  </button>
                </div>
              )}
              {(!immersive || controlsVisible) && (
                <footer className="reading-footer">
                  <button
                    className="icon-button"
                    onClick={() => {
                      void reader.current?.previous()
                    }}
                    aria-label="上一页"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <span>{chapter || '阅读中'}</span>
                  <button
                    className="icon-button"
                    onClick={() => {
                      void reader.current?.next()
                    }}
                    aria-label="下一页"
                  >
                    <ChevronRight size={20} />
                  </button>
                  <span className="reading-saved">
                    <Check size={13} />
                    {Math.round((position?.progress ?? 0) * 100)}%
                  </span>
                </footer>
              )}
            </main>
            {showAssistant && (
              <AssistantPanel
                selection={selection}
                conversation={conversation}
                actions={actions}
                draft={draft}
                running={running || preparing}
                status={preparing ? '正在准备原文…' : runStatus}
                configured={configured}
                onDraft={setDraft}
                onSubmit={ask}
                onAction={askAction}
                onCancel={cancel}
                onNew={newTopic}
                onClose={() => setShowAssistant(false)}
                onSettings={() => setShowSettings(true)}
                onOrigin={() => {
                  if (conversation)
                    void reader.current?.navigate(conversation.snapshot.locator).catch(notify)
                }}
                onCitation={showCitation}
                onSave={(message) => {
                  void saveAnswer(message).catch(notify)
                }}
                onResize={setPanelHeight}
              />
            )}
          </div>
        </>
      )}
      {showSettings && (
        <SettingsDialog
          settings={model}
          apiKey={isTauri() ? '' : apiKey}
          astrbotApiKey={astrbotApiKey}
          hasApiKey={hasApiKey || (!isTauri() && !!apiKey)}
          secureStorage={isTauri()}
          preferences={preferences}
          onSave={async (settings, credentialChange) => {
            const checked = modelSettingsSchema.parse(settings)
            cancel()
            await storage.put('settings', 'model', checked)
            setModel(checked)
            taskRuntime.configureHarness(checked.harness ?? 'builtin', checked.enabled)
            if (checked.harness === 'astrbot') {
              const key = credentialChange.kind === 'set' ? credentialChange.value : ''
              setAstrbotApiKey(key)
              setConfigured(!!key)
              grants.current.clear()
              notify('AstrBot 设置已保存，密钥只保留在本次运行内存。')
              return
            }
            let nextHasApiKey = hasApiKey
            if (isTauri()) {
              if (credentialChange.kind === 'set') {
                await storage.credentialSet(credentialChange.value)
                nextHasApiKey = true
              } else if (credentialChange.kind === 'delete') {
                await storage.credentialDelete()
                nextHasApiKey = false
              }
            } else if (credentialChange.kind === 'set') {
              setApiKey(credentialChange.value)
              nextHasApiKey = true
            } else if (credentialChange.kind === 'delete') {
              setApiKey('')
              nextHasApiKey = false
            }
            setHasApiKey(nextHasApiKey)
            setConfigured(nextHasApiKey || allowsKeylessModelEndpoint(checked.endpoint))
            grants.current.clear()
            if (credentialChange.kind === 'delete') {
              notify(
                isTauri()
                  ? '模型设置已保存，已删除本机保存的密钥。'
                  : '模型设置已保存，已清除本次运行中的密钥。',
              )
            } else {
              notify(
                isTauri()
                  ? '模型设置已保存，密钥保存在本机系统安全凭据区。'
                  : '模型设置已保存，浏览器中的密钥只保留在本次运行内存。',
              )
            }
          }}
          onPreferences={savePreferences}
          onExport={exportBackup}
          onRestore={() => backupInput.current?.click()}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showAppearance && (
        <Modal title="舒适地读下去" onClose={() => setShowAppearance(false)}>
          <Appearance value={preferences} onChange={savePreferences} />
          <div className="modal-footer">
            <span className="muted">排版变化后会保持阅读位置</span>
            <button className="button primary" onClick={() => setShowAppearance(false)}>
              完成
            </button>
          </div>
        </Modal>
      )}
      {noteDraft && (
        <Modal
          title={noteDraft.annotationId ? '修改这段原文的笔记' : '记下此刻的思考'}
          onClose={() => setNoteDraft(null)}
        >
          <blockquote className="note-context">{noteDraft.point.text.slice(0, 500)}</blockquote>
          <label className="field">
            我的笔记
            <textarea
              autoFocus
              rows={6}
              maxLength={20_000}
              value={noteDraft.text}
              onChange={(event) => setNoteDraft({ ...noteDraft, text: event.target.value })}
              placeholder="用自己的话，说说你理解了什么…"
            />
          </label>
          <div className="modal-footer">
            <span className="muted">笔记保存在你的设备上</span>
            <button
              className="button primary"
              disabled={!noteDraft.text.trim()}
              onClick={() => {
                const existing = annotations.find((item) => item.id === noteDraft.annotationId)
                const save = existing
                  ? (async () => {
                      const updated = { ...existing, note: noteDraft.text }
                      await storage.put('annotations', updated.id, updated)
                      setAnnotations((all) =>
                        all.map((item) => (item.id === updated.id ? updated : item)),
                      )
                      notify('笔记已更新。')
                    })()
                  : saveAnnotation('note', noteDraft.point, noteDraft.text)
                void save.then(() => setNoteDraft(null)).catch(notify)
              }}
            >
              保存笔记
            </button>
          </div>
        </Modal>
      )}
      {pending && (
        <Modal title="发送前，看看会分享什么" onClose={dismissPreview} wide>
          <p className="muted">
            {model.harness === 'astrbot'
              ? '问题和下列原文将发送给你的 AstrBot 服务器及其模型。AstrBot 会保存聊天，已启用的其他插件也可能接触这些资料。'
              : '问题和下列原文将发送给你配置的模型服务。服务可能保留收到的内容。'}
          </p>
          <dl className="send-details">
            <div>
              <dt>接收服务</dt>
              <dd>
                {new URL(model.endpoint).host} · {model.model}
              </dd>
            </div>
            <div>
              <dt>资料范围</dt>
              <dd>
                {scopeLabels[pending.snapshot.scope]} · {pending.snapshot.bookTitle}
              </dd>
            </div>
            <div>
              <dt>你的问题</dt>
              <dd>{pending.question}</dd>
            </div>
          </dl>
          <div className="send-preview">
            {pending.snapshot.initial.map((fragment) => (
              <div key={fragment.citationId}>
                <strong>{fragment.label}</strong>
                <p>{fragment.text}</p>
              </div>
            ))}
          </div>
          {conversation && conversation.snapshot.id === pending.snapshot.id && (
            <details className="send-history">
              <summary>还会发送本话题最近的对话</summary>
              {conversation.messages
                .slice(-12)
                .filter((message) => message.status !== 'error')
                .map((message) => (
                  <div key={message.id}>
                    <strong>{message.role === 'user' ? '问题' : '回答'}</strong>
                    <p>{message.content.slice(0, 12_000)}</p>
                  </div>
                ))}
            </details>
          )}
          <p className="small muted">
            后续可在以上范围内取证，每轮有读取上限。普通书内读取无需反复确认。范围或服务变化时会再次预览。
          </p>
          <div className="modal-footer">
            <button className="button" onClick={dismissPreview}>
              暂不发送
            </button>
            <button
              className="button primary"
              onClick={() => {
                grants.current.add(grantKey(pending.snapshot))
                taskRuntime.confirm()
              }}
            >
              允许此书会话发送
            </button>
          </div>
        </Modal>
      )}
      {packPreview && (
        <Modal
          title={
            packs.some((pack) => pack.id === packPreview.id) ? '预览动作包更新' : '预览并安装动作包'
          }
          onClose={() => setPackPreview(null)}
        >
          <div className="pack-preview">
            <Puzzle size={28} />
            <h3>{packPreview.name}</h3>
            <p>{packPreview.description}</p>
            <code>
              {packPreview.id} · v{packPreview.version}
            </code>
            {packPreview.actions.map((action) => (
              <div key={action.id}>
                <strong>{action.label}</strong>
                <p>{action.promptTemplate}</p>
              </div>
            ))}
          </div>
          <p className="small muted">
            不运行代码，不扩大书籍范围，不自动开启联网。同一 ID
            的更新仅凭此预览由你确认，不代表已验证发布者身份。
          </p>
          <div className="modal-footer">
            <button className="button" onClick={() => setPackPreview(null)}>
              取消
            </button>
            <button
              className="button primary"
              onClick={() => {
                void installPack().catch(notify)
              }}
            >
              {packs.some((pack) => pack.id === packPreview.id) ? '确认替换，可回滚' : '安装动作包'}
            </button>
          </div>
        </Modal>
      )}
      {packToDelete && (
        <Modal title="卸载这个动作包？" onClose={() => setPackToDelete(null)}>
          <p>将移除“{packToDelete.manifest.name}”的快捷动作。你已经保存的笔记和问答会保留。</p>
          <div className="modal-footer">
            <button className="button" onClick={() => setPackToDelete(null)}>
              保留
            </button>
            <button
              className="button danger"
              onClick={() => {
                void storage
                  .remove('packs', packToDelete.id)
                  .then(() => {
                    setPacks((current) => current.filter((pack) => pack.id !== packToDelete.id))
                    setPackToDelete(null)
                  })
                  .catch(notify)
              }}
            >
              卸载动作包
            </button>
          </div>
        </Modal>
      )}
      {restorePreview && (
        <Modal title="预览数据恢复" onClose={() => setRestorePreview(null)}>
          <p>
            备份包含 {restorePreview.books.length} 本书、{restorePreview.annotations.length}{' '}
            条标注、{restorePreview.conversations.length} 段问答和 {restorePreview.packs.length}{' '}
            个动作包。
          </p>
          <p className="muted">
            同 ID
            的记录会被备份覆盖，其他记录会保留。恢复前先下载当前数据的备份；密钥不在备份中，现有已保存密钥会保留。若不包含原书，需要重新导入相同
            EPUB。
          </p>
          <div className="modal-footer">
            <button className="button" onClick={() => setRestorePreview(null)}>
              取消
            </button>
            <button
              className="button primary"
              onClick={() => {
                void (async () => {
                  cancel()
                  await taskRuntime.flush()
                  download(
                    `ReadWeave-before-restore-${Date.now()}.json`,
                    JSON.stringify(await createBackup(false), null, 2),
                    'application/json',
                  )
                  await restoreBackup(restorePreview)
                  setPreferences(restorePreview.preferences)
                  setModel(restorePreview.model)
                  taskRuntime.reset()
                  taskRuntime.configureHarness(
                    restorePreview.model.harness ?? 'builtin',
                    restorePreview.model.enabled,
                  )
                  setConfigured(
                    restorePreview.model.harness === 'astrbot'
                      ? !!astrbotApiKey
                      : hasApiKey || allowsKeylessModelEndpoint(restorePreview.model.endpoint),
                  )
                  grants.current.clear()
                  setRestorePreview(null)
                  setShowSettings(false)
                  changeScreen('library')
                  await refreshData()
                  notify('数据已恢复；备份不会改变已保存的模型密钥。')
                })().catch(notify)
              }}
            >
              先备份，再恢复
            </button>
          </div>
        </Modal>
      )}
      {citation && (
        <Modal title="保存的原文片段" onClose={() => setCitation(null)}>
          <p className="section-eyebrow">{citation.fragment.label}</p>
          <blockquote className="citation-source">{citation.fragment.text}</blockquote>
          <p className="small muted">
            此处展示随回答保存的片段。定位时会核对原文；定位成功不保证解释正确。
          </p>
          <div className="modal-footer">
            <button className="button" onClick={() => setCitation(null)}>
              继续查看回答
            </button>
            <button
              className="button primary"
              onClick={() => {
                void navigateCitation()
              }}
            >
              <BookOpen size={16} />
              定位原文
            </button>
          </div>
        </Modal>
      )}
      {archiveConversation && (
        <Modal title="保存的阅读问答" onClose={() => setArchiveConversation(null)} wide>
          <p className="muted">
            {archiveConversation.snapshot.bookTitle} · {archiveConversation.snapshot.chapter}
          </p>
          <div className="archived-messages">
            {archiveConversation.messages.map((message) => (
              <div key={message.id}>
                <strong>
                  {message.role === 'user' ? '你的问题' : '阅读伙伴'}
                  {message.status === 'cancelled'
                    ? '（已取消）'
                    : message.status === 'error'
                      ? '（未完成）'
                      : ''}
                </strong>
                {message.role === 'assistant' && <ModelActivity message={message} />}
                <Answer
                  text={message.content}
                  evidence={archiveConversation.evidence}
                  onCitation={(fragment) => showCitation(fragment, archiveConversation)}
                />
              </div>
            ))}
          </div>
        </Modal>
      )}
      {showBookSearch && (
        <Modal title="在书中寻找原文" onClose={() => setShowBookSearch(false)} wide>
          <label className="search-box book-search-box">
            <Search size={19} />
            <input
              autoFocus
              aria-label="搜索书内原文"
              placeholder="输入一个词或一句话…"
              value={searchTerm}
              maxLength={160}
              onChange={(event) => setSearchTerm(event.target.value)}
            />
          </label>
          <p className="small muted">
            这是你主动查看的全书搜索，不会自动将结果发送给模型。当前原型采用文本扫描，最多展示 30
            条。
          </p>
          <div className="book-search-results">
            {bookSearchResults.map((paragraph) => (
              <button
                key={paragraph.id}
                onClick={() => {
                  void reader.current?.goTo(paragraph.cfi)
                  setShowBookSearch(false)
                }}
              >
                <strong>{paragraph.chapter}</strong>
                <p>{paragraph.text}</p>
              </button>
            ))}
            {searchTerm.trim() && !bookSearchResults.length && (
              <p className="muted">没有找到这段文字，可以换个短词试试。</p>
            )}
          </div>
        </Modal>
      )}
      {showAbout && (
        <Modal title="关于 ReadWeave" onClose={() => setShowAbout(false)}>
          <Brand />
          <p>在原文旁理解，顺畅继续阅读。</p>
          <p className="muted">
            v0.1.0-alpha.9 · P0 / P1 开发原型。沿用 Tauri 2、React 和固定版本的
            foliate-js。正式目标为 Windows 11 与 Android 平板。
          </p>
          <div className="inline-notice">
            <BookOpen size={19} />
            <span>
              {isTauri()
                ? '当前使用原生客户端：书籍保存在应用目录，记录使用 SQLite。'
                : '当前使用浏览器预览：数据存在本浏览器的 IndexedDB，请定期备份。浏览器清理可能删除数据。'}
            </span>
          </div>
          <p className="muted small">
            Android 连续选区、旋转和键盘变化仍待验收；真实模型双服务、Hermes / Connector / MCP
            尚未完成。当前未启用外部搜索、PDF / OCR 或可执行插件。
          </p>
          <p className="small">自研代码 Apache-2.0 · foliate-js MIT · 示例书 CC0</p>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast}</span>
          <button className="icon-button" onClick={() => setToast('')} aria-label="关闭提示">
            <X size={17} />
          </button>
        </div>
      )}
    </div>
  )
}
