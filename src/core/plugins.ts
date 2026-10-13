import { z } from 'zod'

const identifier = z
  .string()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/)
  .max(120)
const actionSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,59}$/),
    label: z.string().min(1).max(30),
    appliesTo: z
      .array(z.enum(['selection', 'viewport']))
      .min(1)
      .max(2),
    promptTemplate: z.string().min(1).max(4000),
  })
  .strict()
export const packSchema = z
  .object({
    manifestVersion: z.literal(1),
    id: identifier,
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .max(30),
    type: z.literal('reading-action-pack'),
    name: z.string().min(1).max(60),
    hostApi: z.literal('1'),
    description: z.string().max(400).optional(),
    actions: z.array(actionSchema).min(1).max(16),
  })
  .strict()
  .superRefine((pack, context) => {
    if (new Set(pack.actions.map((action) => action.id)).size !== pack.actions.length)
      context.addIssue({ code: 'custom', message: '动作 ID 不能重复。' })
    for (const action of pack.actions) {
      for (const match of action.promptTemplate.matchAll(/\{\{([^{}]+)\}\}/g))
        if (!['selection', 'title', 'chapter', 'question'].includes(match[1].trim()))
          context.addIssue({ code: 'custom', message: `不支持模板字段 ${match[1]}。` })
    }
  })
export type ActionPack = z.infer<typeof packSchema>
export type ReadingAction = z.infer<typeof actionSchema>
export interface InstalledPack {
  id: string
  manifest: ActionPack
  enabled: boolean
  installedAt: string
  previous?: ActionPack
}

export function parsePack(text: string): ActionPack {
  if (text.length > 256 * 1024) throw new Error('动作包超过 256 KB 上限。')
  const result = packSchema.safeParse(JSON.parse(text))
  if (!result.success) throw new Error(`动作包格式不符合要求：${result.error.issues[0].message}`)
  return result.data
}
export function renderAction(
  action: ReadingAction,
  fields: { selection: string; title: string; chapter: string; question: string },
): string {
  return action.promptTemplate.replace(
    /\{\{\s*(selection|title|chapter|question)\s*\}\}/g,
    (_match, key: keyof typeof fields) => fields[key],
  )
}
export const defaultPack: ActionPack = {
  manifestVersion: 1,
  id: 'app.readweave.essentials',
  version: '0.1.0',
  type: 'reading-action-pack',
  name: '阅读好伙伴',
  hostApi: '1',
  description: '解释、举例和逐步理解。由你主动发起，资料始终受当前读取范围限制。',
  actions: [
    {
      id: 'explain',
      label: '解释一下',
      appliesTo: ['selection', 'viewport'],
      promptTemplate: '请解释这段内容，先说清核心意思，再补充必要背景。',
    },
    {
      id: 'example',
      label: '举个例子',
      appliesTo: ['selection', 'viewport'],
      promptTemplate: '用一个具体而简单的例子帮助我理解这段内容。说明例子与原文的对应关系。',
    },
    {
      id: 'steps',
      label: '逐步说明',
      appliesTo: ['selection', 'viewport'],
      promptTemplate: '从基础开始，逐步说明这段内容的逻辑或推导。不跳过关键条件。',
    },
    {
      id: 'translate',
      label: '翻译',
      appliesTo: ['selection', 'viewport'],
      promptTemplate:
        '将这段内容翻译成自然的中文；如果原文已是中文，则用更通俗的中文重述。保留术语和关键条件。',
    },
  ],
}
