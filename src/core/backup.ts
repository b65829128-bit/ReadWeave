import { z } from 'zod'
import { packSchema } from './plugins'
import { sha256, storage, type Collection } from './storage'
import type { Annotation, Conversation } from './types'

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const version = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const quote = z
  .object({ exact: z.string().max(6000), prefix: z.string().max(240), suffix: z.string().max(240) })
  .strict()
const locator = z
  .object({
    cfi: z.string().max(4096),
    sectionIndex: z.number().int().min(0).max(512),
    paragraphId: id,
    endOffset: z
      .number()
      .int()
      .min(0)
      .max(2 * 1024 * 1024),
    progress: z.number().min(0).max(1),
    quote: quote.optional(),
  })
  .strict()
const fragment = z
  .object({
    citationId: id,
    ref: id,
    anchorRef: id,
    text: z.string().max(24_000),
    label: z.string().max(500),
  })
  .strict()
const scope = z.enum(['to-position', 'chapter', 'book'])
const snapshot = z
  .object({
    id,
    bookId: hash,
    bookVersion: version,
    bookTitle: z.string().max(300),
    transformVersion: z.string().max(160).optional(),
    contentHash: hash.optional(),
    chapter: z.string().max(500),
    createdAt: z.string().datetime(),
    scope,
    locator,
    selection: z.string().max(6000),
    initial: z.array(fragment).max(32),
  })
  .strict()
const book = z
  .object({
    id: hash,
    version,
    title: z.string().max(300),
    author: z.string().max(300),
    language: z.string().max(100),
    fileName: z.string().max(512),
    addedAt: z.string().datetime(),
    lastOpenedAt: z.string().datetime().optional(),
    position: locator.optional(),
    coverTone: z.number().int().min(0).max(4),
    isSample: z.boolean().optional(),
  })
  .strict()
  .refine((book) => book.version === `sha256:${book.id}`, '书籍哈希与版本不一致。')
const annotation = z
  .object({
    id,
    bookId: hash,
    bookVersion: version,
    kind: z.enum(['highlight', 'bookmark', 'note']),
    text: z.string().max(12_000),
    note: z.string().max(20_000),
    chapter: z.string().max(500),
    locator,
    createdAt: z.string().datetime(),
  })
  .strict()
const toolCall = z
  .object({
    id,
    type: z.literal('function'),
    function: z.object({ name: z.string().max(100), arguments: z.string().max(8192) }).strict(),
  })
  .strict()
const protocolMessage = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().max(64_000).nullable(),
      reasoning_content: z.string().max(128_000).optional(),
      tool_calls: z.array(toolCall).max(6).optional(),
    })
    .strict(),
  z.object({ role: z.literal('tool'), tool_call_id: id, content: z.string().max(64_000) }).strict(),
])
const toolExecution = z
  .object({
    id,
    name: z.string().max(100),
    arguments: z.string().max(8192),
    status: z.enum(['preparing', 'running', 'succeeded', 'error', 'cancelled']),
    summary: z.string().max(1000).optional(),
    result: z.string().max(64_000).optional(),
  })
  .strict()
const conversation = z
  .object({
    id,
    bookId: hash,
    snapshot,
    messages: z
      .array(
        z
          .object({
            id,
            role: z.enum(['user', 'assistant']),
            content: z.string().max(64_000),
            status: z.enum(['done', 'cancelled', 'error']).optional(),
            reasoning: z.string().max(256_000).optional(),
            tools: z.array(toolExecution).max(6).optional(),
            protocol: z.array(protocolMessage).max(13).optional(),
          })
          .strict(),
      )
      .max(200),
    evidence: z.array(fragment).max(256),
    createdAt: z.string().datetime(),
  })
  .strict()
  .refine((c) => c.bookId === c.snapshot.bookId, '会话和快照不属于同一本书。')
const installedPack = z
  .object({
    id: z.string(),
    manifest: packSchema,
    enabled: z.boolean(),
    installedAt: z.string().datetime(),
    previous: packSchema.optional(),
  })
  .strict()
  .refine(
    (p) => p.id === p.manifest.id && (!p.previous || p.previous.id === p.id),
    '动作包身份不一致。',
  )
export const preferencesSchema = z
  .object({
    theme: z.enum(['paper', 'sepia', 'night']),
    fontSize: z.number().min(14).max(30),
    lineHeight: z.number().min(1.4).max(2.4),
    scope,
  })
  .strict()
export const modelSettingsSchema = z
  .object({
    provider: z.enum(['deepseek', 'compatible']).optional(),
    endpoint: z.string().max(2048),
    model: z.string().min(1).max(160),
    systemPrompt: z.string().min(1).max(8000),
    thinking: z.enum(['enabled', 'disabled']).default('enabled'),
    reasoningEffort: z.enum(['low', 'high', 'max']).default('high'),
    maxTokens: z.number().int().min(1024).max(65_536).default(32_768),
  })
  .strict()
  .transform((settings) => ({
    ...settings,
    provider:
      settings.provider ??
      (/^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(settings.endpoint)
        ? ('deepseek' as const)
        : ('compatible' as const)),
  }))
export const backupSchema = z
  .object({
    format: z.literal('readweave-backup'),
    schemaVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    books: z.array(book).max(500),
    annotations: z.array(annotation).max(5000),
    conversations: z.array(conversation).max(1000),
    packs: z.array(installedPack).max(100),
    preferences: preferencesSchema,
    model: modelSettingsSchema,
    originals: z.record(hash, z.string().max(45 * 1024 * 1024)).optional(),
  })
  .strict()
  .superRefine((backup, context) => {
    const books = new Map(backup.books.map((book) => [book.id, book]))
    for (const record of [
      ...backup.annotations,
      ...backup.conversations.map((c) => ({
        bookId: c.bookId,
        bookVersion: c.snapshot.bookVersion,
      })),
    ]) {
      if (!books.has(record.bookId) || books.get(record.bookId)!.version !== record.bookVersion)
        context.addIssue({ code: 'custom', message: '记录引用了缺失或不一致的书籍版本。' })
    }
    for (const key of Object.keys(backup.originals ?? {}))
      if (!books.has(key)) context.addIssue({ code: 'custom', message: '原书不属于此备份。' })
    for (const records of [backup.books, backup.annotations, backup.conversations, backup.packs])
      if (new Set(records.map((r) => r.id)).size !== records.length)
        context.addIssue({ code: 'custom', message: '备份包含重复的记录 ID。' })
  })
export type Backup = z.infer<typeof backupSchema>

export async function createBackup(includeOriginals: boolean): Promise<Backup> {
  const [books, annotations, conversations, packs, preferences, model] = await Promise.all([
    storage.list('books'),
    storage.list('annotations'),
    storage.list('conversations'),
    storage.list('packs'),
    storage.get('settings', 'preferences'),
    storage.get('settings', 'model'),
  ])
  const backup = backupSchema.parse({
    format: 'readweave-backup',
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    books,
    annotations,
    conversations,
    packs,
    preferences,
    model,
  })
  if (includeOriginals) {
    backup.originals = {}
    let total = 0
    for (const book of backup.books) {
      const blob = await storage.getBlob(book.id)
      if (!blob) continue
      total += blob.size
      if (total > 32 * 1024 * 1024)
        throw new Error('含原书的备份暂限总计 32 MB；请取消“包含原书”并单独保留 EPUB。')
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      backup.originals[book.id] = btoa(binary)
    }
  }
  return backup
}

export function parseBackup(text: string): Backup {
  if (text.length > 64 * 1024 * 1024) throw new Error('备份超过 64 MB 上限。')
  const result = backupSchema.safeParse(JSON.parse(text))
  if (!result.success) throw new Error(`备份无效：${result.error.issues[0].message}`)
  return result.data
}

export async function restoreBackup(backup: Backup): Promise<void> {
  const validated = backupSchema.parse(backup)
  const originals: { key: string; blob: Blob }[] = []
  let total = 0
  for (const [key, content] of Object.entries(validated.originals ?? {})) {
    const bytes = Uint8Array.from(atob(content), (character) => character.charCodeAt(0))
    total += bytes.length
    if (total > 32 * 1024 * 1024) throw new Error('备份中的原书总计超过 32 MB。')
    const blob = new Blob([bytes], { type: 'application/epub+zip' })
    if ((await sha256(blob)) !== key) throw new Error('原书哈希校验失败，恢复已停止。')
    originals.push({ key, blob })
  }
  // Validate every blob before writing. Orphaned immutable blobs are harmless if a later write fails.
  for (const original of originals) await storage.putBlob(original.key, original.blob)
  const entries: { collection: Collection; id: string; value: unknown }[] = []
  for (const collection of ['books', 'annotations', 'conversations', 'packs'] as const) {
    for (const record of validated[collection])
      entries.push({ collection, id: record.id, value: record })
  }
  entries.push(
    { collection: 'settings', id: 'preferences', value: validated.preferences },
    { collection: 'settings', id: 'model', value: validated.model },
  )
  await storage.merge(entries)
}

export function exportMarkdown(
  annotations: Annotation[],
  conversations: Conversation[],
  titleFor: (bookId: string) => string,
): string {
  const chunks = [
    '# ReadWeave 阅读记录',
    `导出时间：${new Date().toISOString()}`,
    '引用定位只能核验来源，不能保证解释正确。',
  ]
  for (const annotation of annotations) {
    chunks.push(
      `## ${titleFor(annotation.bookId)} · ${annotation.chapter}`,
      `类型：${{ highlight: '高亮', bookmark: '书签', note: '笔记' }[annotation.kind]}`,
      annotation.text
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n'),
      annotation.note,
      `位置：\`${annotation.locator.cfi}\``,
      `版本：\`${annotation.bookVersion}\``,
    )
  }
  for (const conversation of conversations) {
    chunks.push(
      `## ${titleFor(conversation.bookId)} · 问答`,
      `章节：${conversation.snapshot.chapter}`,
      `选文：${conversation.snapshot.selection || '当前阅读区域'}`,
    )
    for (const message of conversation.messages)
      chunks.push(
        `### ${message.role === 'user' ? '问题' : '解释'}${message.status === 'cancelled' ? '（已取消，内容可能不完整）' : message.status === 'error' ? '（未完成）' : ''}`,
        message.content,
      )
    if (conversation.evidence.length)
      chunks.push(
        '### 已提供的原文依据',
        ...conversation.evidence.map(
          (f) =>
            `- ${f.citationId} · ${f.label}\n\n${f.text
              .split('\n')
              .map((line) => `  > ${line}`)
              .join('\n')}`,
        ),
      )
  }
  return chunks.filter(Boolean).join('\n\n') + '\n'
}
