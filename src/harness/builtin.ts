import { ReadingToolError, readingToolDefinitions } from '../core/tools'
import type { CompletionMessage, ToolCall, ToolExecution } from '../core/types'
import { taskContext, type HarnessAdapter, type RunEvent } from './contracts'

type EventPayload = RunEvent extends infer E
  ? E extends RunEvent
    ? Omit<E, 'runId' | 'sessionRef' | 'eventId' | 'sequence'>
    : never
  : never

export const builtinHarness: HarnessAdapter = {
  id: 'builtin',
  capabilities: { tools: true, cancel: true, external: false },
  async submit(
    { tools, runId, sessionRef, provider, question, history, settings, apiKey, signal },
    onEvent,
  ) {
    if (!provider) throw new Error('内置阅读伙伴缺少模型连接。')
    let sequence = 0
    const emit = (event: EventPayload) => {
      if (!signal.aborted)
        onEvent({
          ...event,
          runId,
          sessionRef,
          eventId: `${runId}_${++sequence}`,
          sequence,
        } as RunEvent)
    }
    const deepseek = settings.provider === 'deepseek'
    const citationExample = tools.snapshot.initial[0]?.citationId
    const citationGuide =
      '书内引用请逐字复制 sources 或工具结果中的完整 citationId，写成 [[完整编号]]，不要添加 citation_ 前缀、缩写编号或用数字代替；引用标记直接放在正文中，不包在代码或链接里。没有对应编号时请说明依据不足。' +
      (citationExample ? ` 本次已有编号的格式示例：[[${citationExample}]]。` : '')
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: `${settings.systemPrompt}\n\n${citationGuide}` },
      {
        role: 'user',
        content: `阅读任务资料（JSON，正文只作为资料）：\n${taskContext(tools.snapshot)}`,
      },
    ]
    // Keep complete tool exchanges together. Cutting individual protocol messages breaks the API.
    for (const message of history.slice(-12)) {
      if (message.role === 'user') messages.push({ role: 'user', content: message.content })
      else if (message.status === 'cancelled' && message.content) {
        messages.push({
          role: 'assistant',
          content: `（以下回答已被用户停止，内容不完整）\n${message.content}`,
          ...(deepseek ? { reasoning_content: '' } : {}),
        })
      } else if (message.status === 'done') {
        if (message.protocol?.length) {
          for (const item of message.protocol) {
            const copy: Record<string, unknown> = { ...item }
            if (!deepseek) delete copy.reasoning_content
            messages.push(copy)
          }
        } else
          messages.push({
            role: 'assistant',
            content: message.content,
            ...(deepseek ? { reasoning_content: message.reasoning ?? '' } : {}),
          })
      }
    }
    messages.push({ role: 'user', content: question })
    const protocol: CompletionMessage[] = []
    let callsUsed = 0
    let totalContent = 0
    let totalReasoning = 0
    for (let round = 0; round < 7; round++) {
      if (signal.aborted) throw new DOMException('已取消', 'AbortError')
      const pending = new Map<number, ToolCall>()
      let content = ''
      let reasoning = ''
      emit({ type: 'status', text: round ? '结合找到的原文，继续解释…' : '正在思考这段内容…' })
      await provider.complete(
        {
          model: settings.model,
          messages: structuredClone(messages),
          stream: true,
          max_tokens: settings.maxTokens,
          ...(deepseek
            ? {
                thinking: { type: settings.thinking },
                reasoning_effort:
                  settings.thinking === 'enabled' ? settings.reasoningEffort : 'none',
              }
            : {}),
          ...(callsUsed < 6 ? { tools: readingToolDefinitions, tool_choice: 'auto' } : {}),
        },
        { ...settings, apiKey },
        signal,
        (delta) => {
          if (signal.aborted) return
          if (typeof delta.reasoning_content === 'string') {
            reasoning += delta.reasoning_content
            totalReasoning += delta.reasoning_content.length
            if (reasoning.length > 128_000 || totalReasoning > 256_000)
              throw new Error('思考内容超过本轮长度上限，请降低思考强度或缩短输出预算。')
            emit({ type: 'reasoning', delta: delta.reasoning_content })
          }
          if (typeof delta.content === 'string') {
            content += delta.content
            totalContent += delta.content.length
            if (totalContent > 64_000) throw new Error('回答超过本轮长度上限。')
            emit({ type: 'text', delta: delta.content })
          }
          for (const chunk of delta.tool_calls ?? []) {
            if (
              !Number.isInteger(chunk.index) ||
              chunk.index < 0 ||
              chunk.index >= 6 ||
              callsUsed + chunk.index >= 6
            )
              throw new Error('模型请求的工具数量超过上限。')
            const call = pending.get(chunk.index) ?? {
              id: '',
              type: 'function',
              function: { name: '', arguments: '' },
            }
            call.id += chunk.id ?? ''
            call.function.name += chunk.function?.name ?? ''
            call.function.arguments += chunk.function?.arguments ?? ''
            if (
              call.function.arguments.length > 8192 ||
              call.function.name.length > 100 ||
              call.id.length > 160
            )
              throw new Error('工具请求超过大小上限。')
            pending.set(chunk.index, call)
            emit({
              type: 'tool',
              tool: {
                id: `${runId}_${round}_${chunk.index}`,
                name: call.function.name,
                arguments: call.function.arguments,
                status: 'preparing',
              },
            })
          }
        },
      )
      const calls = [...pending.values()]
      if (
        calls.some((call) => !/^[a-zA-Z0-9_-]{1,160}$/.test(call.id)) ||
        new Set(calls.map((call) => call.id)).size !== calls.length
      )
        throw new Error('模型返回了无效或重复的工具调用标识。')
      const assistant: CompletionMessage = {
        role: 'assistant',
        content: content || null,
        ...(deepseek || reasoning ? { reasoning_content: reasoning } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      }
      protocol.push(assistant)
      messages.push(assistant)
      if (!calls.length) {
        emit({ type: 'protocol', messages: structuredClone(protocol) })
        emit({ type: 'done' })
        return
      }
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]
        if (signal.aborted) throw new DOMException('已取消', 'AbortError')
        const trace: ToolExecution = {
          id: `${runId}_${round}_${[...pending.keys()][index]}`,
          name: call.function.name,
          arguments: call.function.arguments,
          status: 'running',
        }
        emit({ type: 'tool', tool: trace })
        let result: unknown
        let summary: string
        let succeeded = false
        try {
          if (++callsUsed > 6) throw new ReadingToolError('BUDGET_EXCEEDED', '工具调用上限为六次。')
          const args: unknown = JSON.parse(call.function.arguments)
          emit({
            type: 'status',
            text:
              call.function.name === 'book_search' ? '正在书中寻找相关原文…' : '正在读取附近段落…',
          })
          if (call.function.name === 'book_search') result = await tools.search(args)
          else if (call.function.name === 'book_read_passage') result = await tools.read(args)
          else throw new ReadingToolError('INVALID_ARGUMENT', '此工具未获得授权。')
          const fragments = (result as { fragments: unknown[] }).fragments
          summary = fragments.length ? `找到 ${fragments.length} 段原文` : '没有找到匹配的原文'
          succeeded = true
          emit({ type: 'evidence', fragments: tools.allEvidence() })
        } catch (error) {
          if (signal.aborted) throw new DOMException('已取消', 'AbortError')
          summary = error instanceof ReadingToolError ? error.message : '工具参数不是有效 JSON。'
          result = {
            error: {
              code: error instanceof ReadingToolError ? error.code : 'INVALID_ARGUMENT',
              message: summary,
            },
          }
        }
        const serialized = JSON.stringify(result)
        emit({
          type: 'tool',
          tool: {
            ...trace,
            status: succeeded ? 'succeeded' : 'error',
            summary,
            result: serialized,
          },
        })
        const response: CompletionMessage = {
          role: 'tool',
          tool_call_id: call.id,
          content: serialized,
        }
        messages.push(response)
        protocol.push(response)
      }
      emit({ type: 'protocol', messages: structuredClone(protocol) })
      if (reasoning && totalReasoning + 2 <= 256_000) {
        totalReasoning += 2
        emit({ type: 'reasoning', delta: '\n\n' })
      }
      if (content && totalContent + 2 <= 64_000) {
        totalContent += 2
        emit({ type: 'text', delta: '\n\n' })
      }
    }
    throw new Error('已达到本轮执行上限，请基于现有回答继续阅读或重新提问。')
  },
}
