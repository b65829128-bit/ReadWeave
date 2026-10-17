import { test, expect, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { parseBackup } from '../../src/core/backup'

type ApiMessage = {
  role: string
  content: string | null
  reasoning_content?: string
  tool_calls?: unknown[]
}
type ApiBody = {
  messages: ApiMessage[]
  model: string
  thinking?: { type: string }
  reasoning_effort?: string
  max_tokens: number
}
const requests: ApiBody[] = []
const connections = new Set<ServerResponse>()
let endpoint = ''
const server = createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }
  let raw = ''
  for await (const chunk of request) raw += chunk
  const body = JSON.parse(raw) as ApiBody
  requests.push(body)
  response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  connections.add(response)
  response.on('close', () => connections.delete(response))
  const write = (delta: unknown) =>
    response.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
  const question = body.messages.filter((message) => message.role === 'user').at(-1)?.content ?? ''
  if (body.thinking?.type === 'enabled')
    write({ reasoning_content: '先核对当前阅读范围，再寻找书内证据。' })
  if (question.includes('取消测试')) {
    write({ content: '第一段尚未结束。' })
    const timer = setInterval(() => {
      if (!response.destroyed) write({ content: '后续片段。' })
    }, 150)
    response.on('close', () => clearInterval(timer))
    return
  }
  const tool = body.messages.find((message) => message.role === 'tool')
  if (!tool && !question.includes('追问')) {
    write({
      tool_calls: [
        {
          index: 0,
          id: 'fixture_search',
          type: 'function',
          function: { name: 'book_search', arguments: '{"query":"理解","maxResults":2}' },
        },
      ],
    })
  } else {
    const context = JSON.parse(body.messages[1].content!.split('\n').slice(1).join('\n'))
    const fragment =
      (tool ? JSON.parse(tool.content!).fragments[0] : null) ?? context.sources.at(-1)
    write({
      content: `这是把疑问贴近原文的练习。 [[ ${fragment.citationId} ]]\n\n未提供的引用：[[citation_missing_1-2]]。\n\n$$f(x)=x^2$$\n\n![不自动加载的图片](https://evil.example/ai.png)\n\n<script>window.__aiExecuted=true</script>`,
    })
  }
  response.write('data: [DONE]\n\n')
  response.end()
})
test.beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not start')
  endpoint = `http://127.0.0.1:${address.port}/v1`
})
test.afterAll(async () => {
  for (const response of connections) response.destroy()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
})

async function settingsStorage(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('readweave', 1)
      request.onsuccess = () => resolve(request.result)
    })
    return new Promise((resolve) => {
      const request = db.transaction('settings').objectStore('settings').getAll()
      request.onsuccess = () => {
        resolve(JSON.stringify(request.result))
        db.close()
      }
    })
  })
}

test('AstrBot selection uses server models and keeps its key only in memory', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByLabel('阅读伙伴', { exact: true }).selectOption('astrbot')
  await expect(page.getByLabel('AstrBot 桥接地址', { exact: true })).toHaveValue(
    'http://127.0.0.1:16186',
  )
  await expect(page.getByLabel('模型名称', { exact: true })).toHaveCount(0)
  await page.getByLabel('服务密钥', { exact: true }).fill('abk_synthetic_external_memory')
  await page.getByRole('button', { name: '保存设置' }).click()
  const saved = await settingsStorage(page)
  expect(saved).toContain('astrbot')
  expect(saved).not.toContain('abk_synthetic_external_memory')
  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByLabel('阅读伙伴', { exact: true }).selectOption('builtin')
  await expect(page.getByLabel('模型名称', { exact: true })).toBeVisible()
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveValue('')
  await page.getByLabel('阅读伙伴', { exact: true }).selectOption('astrbot')
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveValue(
    'abk_synthetic_external_memory',
  )
  await page.reload()
  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByLabel('阅读伙伴', { exact: true })).toHaveValue('astrbot')
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveValue('')
})

test('streamed tool loop, frozen context, verified citation, follow-up, cancellation and ephemeral key', async ({
  page,
}) => {
  const policy = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
  await page
    .context()
    .grantPermissions(['local-network-access'], { origin: 'http://127.0.0.1:1430' })
  await page.route('http://127.0.0.1:1430/', async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'Content-Security-Policy': policy },
    })
  })
  const remoteRequests: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('evil.example')) remoteRequests.push(request.url())
  })
  await page.goto('/')
  await page.getByRole('button', { name: '开始阅读' }).click()
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  await page.getByRole('button', { name: '模型设置' }).click()
  await page.getByRole('textbox', { name: '服务地址' }).fill(endpoint)
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model')
  await page.getByLabel('思考强度', { exact: true }).selectOption('max')
  await page.getByLabel('单次输出预算', { exact: true }).selectOption('16384')
  await page.getByLabel('服务密钥', { exact: true }).fill('ephemeral-test-secret')
  await page.getByRole('button', { name: '保存设置' }).click()
  const frame = page.frames().find((frame) => frame.url().startsWith('blob:'))!
  await frame
    .locator('p')
    .first()
    .evaluate((element) => {
      const range = element.ownerDocument.createRange()
      range.selectNodeContents(element)
      const selection = element.ownerDocument.defaultView!.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      element.ownerDocument.dispatchEvent(new Event('selectionchange'))
    })
  const selected = await frame.locator('p').first().textContent()
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('为什么这句话值得停下来理解？')
  await page.getByRole('button', { name: '发送问题' }).click()
  await expect(page.getByRole('dialog')).toContainText(selected!)
  await page.getByRole('button', { name: '允许此书会话发送' }).click()
  await page.getByRole('button', { name: '下一页' }).click()
  await expect(page.locator('.answer-markdown')).toContainText('这是把疑问贴近原文的练习。')
  await expect(page.locator('.answer-markdown')).toContainText('引用未核验')
  await expect(page.locator('.answer-markdown')).not.toContainText('[[citation_')
  await expect(page.locator('.katex')).toBeVisible()
  await expect(page.getByRole('button', { name: '停止回答' })).toHaveCount(0)
  const context = JSON.parse(requests[0].messages[1].content!.split('\n').slice(1).join('\n'))
  expect(context.selection).toBe(selected)
  expect(JSON.stringify(requests[0])).not.toContain('想象你正在读一部历史书')
  expect(requests[1].messages.some((message) => message.role === 'tool')).toBe(true)
  expect(requests[0].thinking).toEqual({ type: 'enabled' })
  expect(requests[0].reasoning_effort).toBe('max')
  expect(requests[0].max_tokens).toBe(16384)
  expect(
    requests[1].messages.find((message) => message.role === 'assistant')?.reasoning_content,
  ).toContain('先核对当前阅读范围')
  await expect(page.locator('.reasoning-block summary')).toContainText('思考过程')
  await page.locator('.reasoning-block summary').click()
  await expect(page.locator('.reasoning-content')).toContainText('先核对当前阅读范围')
  await expect(
    page.getByRole('complementary', { name: '阅读伙伴' }).getByLabel('工具调用记录'),
  ).toContainText('搜索书内原文')
  await page.locator('.tool-execution summary').click()
  await expect(page.locator('.tool-detail')).toContainText('book_search')
  await expect(page.locator('.tool-detail')).toContainText('"query": "理解"')
  await expect(page.locator('.tool-detail')).toContainText('返回结果')
  await page.locator('.tool-execution summary').click()
  await page.screenshot({ path: '.local/screenshots/model-activity.png', fullPage: true })
  expect(remoteRequests).toEqual([])
  expect(await page.evaluate(() => '__aiExecuted' in window)).toBe(false)
  await page.getByRole('button', { name: '原文', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('保存的原文片段')
  await page.getByRole('button', { name: '定位原文' }).click()
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('追问：用自己的话再说一次。')
  await page.getByRole('button', { name: '发送问题' }).click()
  await expect(page.locator('.message-assistant')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '停止回答' })).toHaveCount(0)
  expect(
    JSON.parse(requests[2].messages[1].content!.split('\n').slice(1).join('\n')).snapshotId,
  ).toBe(context.snapshotId)
  expect(requests[2].messages.filter((message) => message.role === 'user')).toHaveLength(3)
  expect(requests[2].messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
  expect(
    requests[2].messages
      .filter((message) => message.role === 'assistant')
      .every((message) => message.reasoning_content?.includes('先核对当前阅读范围')),
  ).toBe(true)
  await page.getByRole('button', { name: '开始新话题' }).click()
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('取消测试')
  await page.getByRole('button', { name: '发送问题' }).click()
  await expect(page.locator('.answer-markdown')).toContainText('第一段尚未结束。')
  await page.getByRole('button', { name: '停止回答' }).click()
  await expect(page.getByText('已停止，以上内容可能不完整。')).toBeVisible()
  await page.getByRole('button', { name: '返回书架' }).click()
  await page.getByRole('button', { name: '阅读笔记', exact: true }).click()
  await page.getByRole('button', { name: /阅读问答/ }).click()
  await expect(page.locator('.conversation-card')).toHaveCount(2)
  await page.locator('.conversation-card').filter({ hasText: '为什么这句话值得停下来理解' }).click()
  await expect(page.getByRole('dialog').getByLabel('工具调用记录')).toContainText('搜索书内原文')
  await expect(page.getByRole('dialog').locator('.reasoning-block')).toHaveCount(2)
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByRole('button', { name: '数据与备份', exact: true }).click()
  const backupDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON 备份', exact: true }).click()
  const backup = parseBackup(readFileSync((await (await backupDownload).path())!, 'utf8'))
  expect(
    backup.conversations
      .flatMap((item) => item.messages)
      .some((message) => message.protocol?.some((turn) => turn.role === 'tool')),
  ).toBe(true)
  expect(
    backup.conversations
      .flatMap((item) => item.messages)
      .some((message) => message.reasoning?.includes('先核对当前阅读范围')),
  ).toBe(true)
  expect(JSON.stringify(backup)).not.toContain('ephemeral-test-secret')
  expect(backup.conversations.every((item) => item.backend?.harnessId === 'builtin')).toBe(true)
  const runIds = backup.conversations.flatMap((item) =>
    item.messages.flatMap((message) => (message.run ? [message.run.id] : [])),
  )
  expect(runIds.length).toBe(3)
  expect(new Set(runIds).size).toBe(runIds.length)
  expect(await settingsStorage(page)).not.toContain('ephemeral-test-secret')
  await page.reload()
  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveValue('')
})

test('deleting a saved key allows a remote model configuration to be saved', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByRole('textbox', { name: '服务地址' }).fill(endpoint)
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model')
  await page.getByLabel('服务密钥', { exact: true }).fill('synthetic-delete-test-key')
  await page.getByRole('button', { name: '保存设置' }).click()

  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByRole('button', { name: '删除已保存密钥' }).click()
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('模型设置已保存，已清除本次运行中的密钥。')).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByRole('button', { name: '删除已保存密钥' })).toHaveCount(0)
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveAttribute(
    'placeholder',
    '输入服务密钥',
  )
})

async function configureFixture(page: Page) {
  await page
    .context()
    .grantPermissions(['local-network-access'], { origin: 'http://127.0.0.1:1430' })
  await page.getByRole('button', { name: '模型设置' }).click()
  await page.getByRole('textbox', { name: '服务地址' }).fill(endpoint)
  await page.getByLabel('模型名称', { exact: true }).fill('fixture-model')
  await page.getByRole('button', { name: '保存设置' }).click()
}

test('switching books during a stream archives the cancelled run and starts a separate session', async ({
  page,
}) => {
  const before = requests.length
  await page.goto('/')
  await page.getByRole('button', { name: '开始阅读' }).click()
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  await configureFixture(page)
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('取消测试：稍后换书')
  await page.getByRole('button', { name: '发送问题' }).click()
  await page.getByRole('button', { name: '允许此书会话发送' }).click()
  await expect(page.locator('.answer-markdown')).toContainText('第一段尚未结束。')
  await page.getByRole('button', { name: '返回书架' }).click()
  await page.locator('.book-card').filter({ hasText: '梯度下降的第一步' }).click()
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('追问：这本书的开头讲了什么？')
  await page.getByRole('button', { name: '发送问题' }).click()
  await expect(page.getByRole('dialog')).toContainText('梯度下降的第一步')
  await page.getByRole('button', { name: '允许此书会话发送' }).click()
  await expect(page.locator('.answer-markdown')).toContainText('这是把疑问贴近原文的练习。')
  await expect(page.getByRole('button', { name: '停止回答' })).toHaveCount(0)
  await expect(page.locator('.message-assistant')).toHaveCount(1)
  await expect(page.locator('.message-assistant')).not.toContainText('第一段尚未结束。')
  const runs = requests.slice(before)
  expect(runs).toHaveLength(2)
  const context = (body: ApiBody) =>
    JSON.parse(body.messages[1].content!.split('\n').slice(1).join('\n'))
  expect(context(runs[1]).book).toBe('梯度下降的第一步')
  expect(context(runs[1]).snapshotId).not.toBe(context(runs[0]).snapshotId)
  await page.getByRole('button', { name: '返回书架' }).click()
  await page.getByRole('button', { name: '阅读笔记', exact: true }).click()
  await page.getByRole('button', { name: /阅读问答/ }).click()
  await expect(page.locator('.conversation-card')).toHaveCount(2)
})

test('disabling the assistant stops its stream, survives reload, and requires new consent after re-enabling', async ({
  page,
}) => {
  const before = requests.length
  await page.goto('/')
  await page.getByRole('button', { name: '开始阅读' }).click()
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  await configureFixture(page)
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('取消测试：停用阅读伙伴')
  await page.getByRole('button', { name: '发送问题' }).click()
  await page.getByRole('button', { name: '允许此书会话发送' }).click()
  await expect(page.locator('.answer-markdown')).toContainText('第一段尚未结束。')
  await page.getByRole('button', { name: '模型设置' }).click()
  await page.getByRole('checkbox', { name: '启用阅读伙伴' }).uncheck()
  await page.getByRole('button', { name: '保存设置' }).click()
  await expect(page.getByText('已停止，以上内容可能不完整。')).toBeVisible()
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('停用时不应发送')
  await page.getByRole('button', { name: '发送问题' }).click()
  await expect(page.getByRole('checkbox', { name: '启用阅读伙伴' })).not.toBeChecked()
  expect(requests.slice(before)).toHaveLength(1)
  await page.reload()
  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByRole('checkbox', { name: '启用阅读伙伴' })).not.toBeChecked()
  await page.getByRole('checkbox', { name: '启用阅读伙伴' }).check()
  await page.getByRole('button', { name: '保存设置' }).click()
  await page.getByRole('button', { name: '继续阅读', exact: true }).click()
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('追问：重新启用后的问题')
  await page.getByRole('button', { name: '发送问题' }).click()
  await page.getByRole('button', { name: '允许此书会话发送' }).click()
  await expect(page.locator('.answer-markdown')).toContainText('这是把疑问贴近原文的练习。')
  await expect(page.getByRole('button', { name: '停止回答' })).toHaveCount(0)
  expect(requests.slice(before)).toHaveLength(2)
})
