import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import type { ModelSettings } from '../core/types'
import type { ProviderAdapter, ProviderDelta } from './contracts'

export function completionEndpoint(base: string): string {
  const url = new URL(base.trim())
  if (url.username || url.password || url.search || url.hash)
    throw new Error('服务地址不能包含密钥、查询参数或片段。')
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  )
    throw new Error('远程模型服务必须使用 HTTPS；HTTP 仅限本机开发服务。')
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (!url.pathname.endsWith('/chat/completions')) url.pathname += '/chat/completions'
  return url.toString()
}

/** Streaming records can span arbitrary network chunks, including UTF-8 code points. */
export class SseDecoder {
  private buffer = ''
  private finished = false
  private terminal = false
  constructor(private onDelta: (delta: ProviderDelta) => void) {}
  push(chunk: string) {
    if (this.finished) return
    this.buffer += chunk
    if (this.buffer.length > 256 * 1024) throw new Error('模型返回的数据块过大。')
    let match: RegExpExecArray | null
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      const record = this.buffer.slice(0, match.index)
      this.buffer = this.buffer.slice(match.index + match[0].length)
      this.record(record)
    }
  }
  private record(record: string) {
    const payload = record
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
    if (!payload || this.finished) return
    if (payload.trim() === '[DONE]') {
      this.finished = true
      return
    }
    const event = JSON.parse(payload) as {
      error?: unknown
      choices?: { delta?: ProviderDelta; finish_reason?: string | null }[]
    }
    if (event.error) throw new Error('模型服务返回错误，请检查配置或额度。')
    const choice = event.choices?.[0]
    if (choice?.delta) this.onDelta(choice.delta)
    if (choice?.finish_reason) {
      this.terminal = true
      if (choice.finish_reason === 'length')
        throw new Error('已达到输出预算，内容可能不完整。请提高输出预算或降低思考强度后重试。')
      if (!['stop', 'tool_calls'].includes(choice.finish_reason))
        throw new Error('模型服务中止了此次生成，内容可能不完整。')
    }
  }
  finish() {
    if (this.buffer.trim()) this.record(this.buffer)
    if (!this.finished && !this.terminal) throw new Error('回答传输中断，内容可能不完整。')
  }
}

export const compatibleProvider: ProviderAdapter = {
  id: 'chat-completions-compatible',
  async complete(body, config: ModelSettings & { apiKey: string }, signal, onDelta) {
    const endpoint = completionEndpoint(config.endpoint)
    const serialized = JSON.stringify(body)
    if (new TextEncoder().encode(serialized).length > 512 * 1024)
      throw new Error('会话上下文已达到大小上限，请开始新话题后再提问。')
    const parser = new SseDecoder(onDelta)
    const decoder = new TextDecoder()
    if (signal.aborted) throw new DOMException('已取消', 'AbortError')
    if (isTauri()) {
      const requestId = crypto.randomUUID()
      const channel = new Channel<number[]>()
      let parseError: unknown
      channel.onmessage = (bytes) => {
        if (signal.aborted || parseError) return
        try {
          parser.push(decoder.decode(new Uint8Array(bytes), { stream: true }))
        } catch (error) {
          parseError = error
          void invoke('completion_cancel', { requestId }).catch(() => undefined)
        }
      }
      const cancel = () => {
        void invoke('completion_cancel', { requestId }).catch(() => undefined)
      }
      signal.addEventListener('abort', cancel, { once: true })
      try {
        await invoke('completion_stream', {
          request: { requestId, endpoint, apiKey: config.apiKey, body },
          channel,
        })
        if (parseError) throw parseError
        if (signal.aborted) throw new DOMException('已取消', 'AbortError')
        parser.push(decoder.decode())
        parser.finish()
      } catch (error) {
        if (parseError) throw parseError
        if (signal.aborted) throw new DOMException('已取消', 'AbortError')
        throw new Error(
          typeof error === 'string'
            ? `模型请求失败（${error}）。`
            : error instanceof Error
              ? error.message
              : '模型请求失败。',
          { cause: error },
        )
      } finally {
        signal.removeEventListener('abort', cancel)
      }
      return
    }
    const timeout = AbortSignal.timeout(600_000)
    const response = await fetch(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: serialized,
      signal: AbortSignal.any([signal, timeout]),
    })
    if (!response.ok)
      throw new Error(`模型请求失败（HTTP ${response.status}）。请检查地址、密钥和额度。`)
    if (!response.body) throw new Error('服务未返回流式回答。')
    const reader = response.body.getReader()
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 16 * 1024 * 1024) throw new Error('模型回答超过大小上限。')
        parser.push(decoder.decode(value, { stream: true }))
      }
      parser.push(decoder.decode())
      parser.finish()
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  },
}
