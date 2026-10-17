import type { ReadingTask } from '../core/reading-service'
import type {
  Conversation,
  Fragment,
  Locator,
  Message,
  ModelSettings,
  ReadScope,
  Snapshot,
} from '../core/types'
import type { HarnessAdapter, ProviderAdapter, RunEvent } from './contracts'
import { AdapterRegistry } from './registry'

type Backend = { harness: HarnessAdapter; provider?: ProviderAdapter }
type Session = Backend & {
  tools: ReadingTask
  settings: ModelSettings
  apiKey: string
  sessionRef: string
  createTask: PrepareRun['createTask']
  inheritedEvidence: Fragment[]
  priorTasks: ReadingTask[]
}
type PreparedRun = Session & { question: string; resumeConversationId?: string }
type Execution = {
  id: string
  sessionRef: string
  assistantId: string
  controller: AbortController
  context: PreparedRun
  conversation: Conversation
  sequence: number
  eventIds: Set<string>
}

export interface RuntimeState {
  phase: 'idle' | 'preparing' | 'preview' | 'running'
  conversation: Conversation | null
  pending: { snapshot: Snapshot; question: string } | null
  status: string
}
export interface RuntimePersistence {
  save(conversation: Conversation): Promise<void>
  onSaved?(conversation: Conversation): void
  onError(error: unknown): void
}
export interface PrepareRun {
  bookId: string
  bookVersion: string
  scope: ReadScope
  question: string
  settings: ModelSettings
  apiKey: string
  createTask(signal: AbortSignal): Promise<ReadingTask>
  isApproved(snapshot: Snapshot): boolean
}

/** Owns host task state. ReadingTask remains the authority for scope, budget and evidence. */
export class TaskRuntime {
  private state: RuntimeState = { phase: 'idle', conversation: null, pending: null, status: '' }
  private listeners = new Set<() => void>()
  private preparation: { controller: AbortController; backend: Backend } | null = null
  private preview: PreparedRun | null = null
  private session: Session | null = null
  private continuation: Session | null = null
  private active: Execution | null = null
  private revoked = new WeakSet<ReadingTask>()
  private saveTails = new Map<string, Promise<void>>()
  private saves = new Set<Promise<void>>()
  private saveErrors = new Map<string, { error: unknown; snapshot: Conversation }>()

  constructor(
    readonly harnesses: AdapterRegistry<HarnessAdapter>,
    readonly providers: AdapterRegistry<ProviderAdapter>,
    private persistence: RuntimePersistence,
  ) {
    harnesses.subscribe(() => this.selectionChanged())
    providers.subscribe(() => this.selectionChanged())
  }

  getSnapshot = (): RuntimeState => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setEnabled(enabled: boolean) {
    const id = this.harnesses.selectedId
    if (id) this.harnesses.setEnabled(id, enabled)
  }

  configureHarness(id: string, enabled: boolean) {
    this.harnesses.setEnabled(id, true)
    this.harnesses.select(id)
    this.harnesses.setEnabled(id, enabled)
  }

  async prepare(request: PrepareRun): Promise<void> {
    if (!request.question.trim() || this.state.phase !== 'idle') return
    const { bookId, bookVersion, scope, question, apiKey, createTask, isApproved } = request
    const controller = new AbortController()
    let tools: ReadingTask | undefined
    try {
      const harness = this.harnesses.current()
      const provider = harness?.capabilities.external
        ? undefined
        : (this.providers.current() ?? undefined)
      if (!request.settings.enabled || !harness || (!harness.capabilities.external && !provider))
        throw new Error('阅读伙伴已停用或不可用，请在设置中重新启用。')
      if (
        !harness.capabilities.tools ||
        !harness.capabilities.cancel ||
        (provider &&
          (!provider.capabilities.streaming ||
            !provider.capabilities.tools ||
            !provider.capabilities.cancel))
      )
        throw new Error('所选连接不支持当前阅读任务所需的流式回答、书内工具或取消。')
      const backend = { harness, provider }
      const settings = structuredClone(request.settings)
      this.preparation = { controller, backend }
      this.update({ phase: 'preparing', pending: null, status: '' })
      const previous = this.session
      const matches = (candidate: Session | null): candidate is Session =>
        !!candidate &&
        this.isCurrent(candidate) &&
        candidate.tools.snapshot.bookId === bookId &&
        candidate.tools.snapshot.bookVersion === bookVersion &&
        candidate.tools.snapshot.scope === scope &&
        candidate.tools.snapshot.id === this.state.conversation?.snapshot.id &&
        JSON.stringify(candidate.settings) === JSON.stringify(settings) &&
        candidate.apiKey === apiKey
      const resuming = matches(this.continuation) ? this.continuation : null
      this.continuation = null
      let factory = createTask
      let inheritedEvidence: Fragment[] = []
      let priorTasks: ReadingTask[] = []
      if (matches(previous)) {
        tools = previous.tools
        factory = previous.createTask
        inheritedEvidence = previous.inheritedEvidence
        priorTasks = previous.priorTasks
      } else {
        this.releaseSession()
        factory = resuming?.createTask ?? createTask
        inheritedEvidence = resuming ? structuredClone(this.state.conversation!.evidence) : []
        priorTasks = resuming ? [...resuming.priorTasks, resuming.tools] : []
        if (resuming) await resuming.tools.revoke()
        if (controller.signal.aborted || this.preparation?.controller !== controller) return
        tools = await factory(controller.signal)
      }
      if (controller.signal.aborted || this.preparation?.controller !== controller) {
        this.release(tools)
        return
      }
      if (
        tools.snapshot.bookId !== bookId ||
        tools.snapshot.bookVersion !== bookVersion ||
        tools.snapshot.scope !== scope
      )
        throw new Error('阅读任务与当前书籍版本或授权范围不一致。')
      if (resuming) {
        if (
          tools === resuming.tools ||
          tools.runId === resuming.tools.runId ||
          tools.snapshot.id === resuming.tools.snapshot.id
        )
          throw new Error('继续对话需要重新建立读取授权，请开始新话题。')
        const original = resuming.tools.snapshot
        if (
          tools.snapshot.locator.cfi !== original.locator.cfi ||
          tools.snapshot.locator.paragraphId !== original.locator.paragraphId ||
          tools.snapshot.locator.sectionIndex !== original.locator.sectionIndex ||
          tools.snapshot.locator.endOffset !== original.locator.endOffset ||
          tools.snapshot.selection !== original.selection ||
          tools.snapshot.contentHash !== original.contentHash ||
          tools.snapshot.transformVersion !== original.transformVersion
        )
          throw new Error('继续对话的阅读边界发生变化，请开始新话题。')
      }
      const sessionRef = previous?.tools === tools ? previous.sessionRef : crypto.randomUUID()
      this.session = {
        ...backend,
        tools,
        settings,
        apiKey,
        sessionRef,
        createTask: factory,
        inheritedEvidence,
        priorTasks,
      }
      const prepared = {
        ...this.session,
        question,
        ...(resuming ? { resumeConversationId: this.state.conversation!.id } : {}),
      }
      const approved = isApproved(tools.snapshot)
      this.preparation = null
      if (approved) this.begin(prepared)
      else {
        this.preview = prepared
        this.update({
          phase: 'preview',
          pending: {
            snapshot: structuredClone(tools.snapshot),
            question,
          },
        })
      }
    } catch (error) {
      if (controller.signal.aborted) return
      this.preparation = null
      if (tools) this.release(tools)
      this.releaseSession()
      this.update({ phase: 'idle', pending: null, status: '' })
      this.persistence.onError(error)
    }
  }

  confirm() {
    const prepared = this.preview
    if (!prepared || this.state.phase !== 'preview') return
    if (!this.isCurrent(prepared)) {
      this.cancel()
      return
    }
    this.preview = null
    this.begin(prepared)
  }

  stop() {
    this.cancel(true)
  }

  cancel(continueConversation = false) {
    this.continuation = continueConversation && this.active ? this.session : null
    const preparation = this.preparation
    this.preparation = null
    preparation?.controller.abort()
    this.preview = null
    if (this.active) {
      const run = this.active
      run.controller.abort()
      this.finish(run, 'cancelled')
    }
    this.releaseSession()
    this.update({ phase: 'idle', pending: null, status: '' })
  }

  reset() {
    this.cancel()
    this.update({ conversation: null })
  }

  async flush() {
    for (const [id, failure] of this.saveErrors) {
      if (!this.saveTails.has(id)) this.save(failure.snapshot)
    }
    while (this.saves.size) await Promise.allSettled([...this.saves])
    if (this.saveErrors.size) throw this.saveErrors.values().next().value!.error
  }

  async resolveAnchor(
    bookId: string,
    bookVersion: string,
    fragment: Fragment,
  ): Promise<Locator | null> {
    const session = this.session ?? this.continuation
    if (
      !session ||
      session.tools.snapshot.bookId !== bookId ||
      session.tools.snapshot.bookVersion !== bookVersion
    )
      return null
    for (const task of [session.tools, ...[...session.priorTasks].reverse()]) {
      const locator = await task.resolveAnchor(fragment)
      if (locator) return locator
    }
    return null
  }

  private begin(context: PreparedRun) {
    const previous =
      this.state.conversation?.snapshot.id === context.tools.snapshot.id ||
      (context.resumeConversationId && this.state.conversation?.id === context.resumeConversationId)
        ? this.state.conversation
        : null
    const id = crypto.randomUUID()
    const assistantId = crypto.randomUUID()
    const conversation: Conversation = previous
      ? {
          ...previous,
          snapshot: structuredClone(context.tools.snapshot),
          messages: [...previous.messages],
          evidence: this.evidence(context),
          backend: {
            harnessId: context.harness.id,
            ...(context.provider ? { providerId: context.provider.id } : {}),
            sessionRef: context.sessionRef,
          },
        }
      : {
          id: crypto.randomUUID(),
          bookId: context.tools.snapshot.bookId,
          snapshot: structuredClone(context.tools.snapshot),
          messages: [],
          evidence: context.tools.allEvidence(),
          createdAt: new Date().toISOString(),
          backend: {
            harnessId: context.harness.id,
            ...(context.provider ? { providerId: context.provider.id } : {}),
            sessionRef: context.sessionRef,
          },
        }
    conversation.messages.push(
      { id: crypto.randomUUID(), role: 'user', content: context.question },
      { id: assistantId, role: 'assistant', content: '', run: { id, sequence: 0 } },
    )
    const run: Execution = {
      id,
      assistantId,
      context,
      conversation,
      sessionRef: conversation.backend!.sessionRef,
      controller: new AbortController(),
      sequence: 0,
      eventIds: new Set(),
    }
    this.active = run
    this.update({ phase: 'running', pending: null, conversation, status: '' })
    void this.execute(run)
  }

  private async execute(run: Execution) {
    try {
      const { tools, harness, provider, settings, apiKey, question } = run.context
      await harness.submit(
        {
          tools,
          provider,
          settings,
          apiKey,
          question,
          runId: run.id,
          sessionRef: run.sessionRef,
          history: run.conversation.messages.slice(0, -2),
          priorEvidence: run.conversation.evidence,
          signal: run.controller.signal,
        },
        (event) => this.accept(run, event),
      )
      if (this.active === run) throw new Error('回答未收到完成标记，以上内容可能不完整。')
    } catch (error) {
      if (this.active !== run) return
      this.finish(run, 'error')
      if (run.context.harness.capabilities.external) this.releaseSession()
      this.persistence.onError(
        error instanceof TypeError
          ? new Error(
              '无法连接模型服务。请检查网络和地址；浏览器预览还需要服务支持跨域，Windows 客户端不受此限制。',
            )
          : error,
      )
    }
  }

  private accept(run: Execution, event: RunEvent) {
    if (
      this.active !== run ||
      run.controller.signal.aborted ||
      event.runId !== run.id ||
      event.sessionRef !== run.sessionRef
    )
      return
    if (run.eventIds.has(event.eventId) || event.sequence <= run.sequence) return
    if (
      !Number.isSafeInteger(event.sequence) ||
      event.sequence !== run.sequence + 1 ||
      !/^[a-zA-Z0-9_-]{1,160}$/.test(event.eventId)
    ) {
      this.finish(run, 'error')
      run.controller.abort()
      this.releaseSession()
      this.persistence.onError(new Error('回答事件顺序中断，以上内容可能不完整，请重新提问。'))
      return
    }
    run.sequence = event.sequence
    run.eventIds.add(event.eventId)
    this.answer(run, (message) => ({
      ...message,
      run: { id: run.id, sequence: event.sequence, eventId: event.eventId },
    }))
    switch (event.type) {
      case 'text':
        this.answer(run, (message) => ({ ...message, content: message.content + event.delta }))
        break
      case 'reasoning':
        this.answer(run, (message) => ({
          ...message,
          reasoning: (message.reasoning ?? '') + event.delta,
        }))
        break
      case 'tool':
        this.answer(run, (message) => ({
          ...message,
          tools: [
            ...(message.tools ?? []).filter((tool) => tool.id !== event.tool.id),
            structuredClone(event.tool),
          ],
        }))
        break
      case 'protocol':
        this.answer(run, (message) => ({ ...message, protocol: structuredClone(event.messages) }))
        break
      case 'evidence':
        run.conversation = { ...run.conversation, evidence: this.evidence(run.context) }
        break
      case 'done':
        this.finish(run, 'done')
        return
    }
    this.update({
      conversation: run.conversation,
      ...(event.type === 'status' ? { status: event.text } : {}),
    })
  }

  private finish(run: Execution, status: NonNullable<Message['status']>) {
    if (this.active !== run) return
    this.active = null
    this.answer(run, (message) => ({
      ...message,
      status,
      tools: message.tools?.map((tool) =>
        ['preparing', 'running'].includes(tool.status)
          ? {
              ...tool,
              status: status === 'cancelled' ? 'cancelled' : 'error',
              summary: status === 'cancelled' ? '已停止' : '此次调用未完成',
            }
          : tool,
      ),
    }))
    run.conversation = { ...run.conversation, evidence: this.evidence(run.context) }
    this.save(run.conversation)
    this.update({ phase: 'idle', conversation: run.conversation, status: '' })
  }

  private answer(run: Execution, transform: (message: Message) => Message) {
    run.conversation = {
      ...run.conversation,
      messages: run.conversation.messages.map((message) =>
        message.id === run.assistantId ? transform(message) : message,
      ),
    }
  }

  private evidence(session: Session) {
    return [
      ...new Map(
        [...session.inheritedEvidence, ...session.tools.allEvidence()].map((fragment) => [
          fragment.citationId,
          structuredClone(fragment),
        ]),
      ).values(),
    ]
  }

  private save(conversation: Conversation) {
    const snapshot = structuredClone(conversation)
    const previous = this.saveTails.get(snapshot.id) ?? Promise.resolve()
    const saved = previous.catch(() => undefined).then(() => this.persistence.save(snapshot))
    this.saveTails.set(snapshot.id, saved)
    this.saves.add(saved)
    const cleanup = () => {
      this.saves.delete(saved)
      if (this.saveTails.get(snapshot.id) === saved) this.saveTails.delete(snapshot.id)
    }
    void saved.then(
      () => {
        this.saveErrors.delete(snapshot.id)
        cleanup()
        this.persistence.onSaved?.(snapshot)
      },
      (error) => {
        this.saveErrors.set(snapshot.id, { error, snapshot })
        cleanup()
        this.persistence.onError(error)
      },
    )
  }

  private isCurrent(backend: Backend) {
    return (
      this.harnesses.current() === backend.harness &&
      (backend.harness.capabilities.external || this.providers.current() === backend.provider)
    )
  }

  private selectionChanged() {
    const backend = this.preparation?.backend ?? this.preview ?? this.session ?? this.continuation
    if (backend && !this.isCurrent(backend)) this.cancel()
  }

  private releaseSession() {
    if (this.session) {
      const session = this.session
      this.release(session.tools)
      if (session.harness.closeSession)
        void session.tools
          .revoke()
          .then(() => session.harness.closeSession!(session.sessionRef))
          .catch((error) => this.persistence.onError(error))
    }
    this.session = null
  }

  private release(task: ReadingTask) {
    if (this.revoked.has(task)) return
    this.revoked.add(task)
    void task.revoke().catch((error) => this.persistence.onError(error))
  }

  private update(patch: Partial<RuntimeState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
