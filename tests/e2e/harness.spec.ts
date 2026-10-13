import { test, expect, type Page } from '@playwright/test'
import { createServer, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'

type ApiMessage = { role: string; content: string | null }
type ApiBody = { messages: ApiMessage[]; model: string }
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
    const fragment = tool ? JSON.parse(tool.content!).fragments[0] : context.sources.at(-1)
    write({
      content: `这是把疑问贴近原文的练习。 [[${fragment.citationId}]]\n\n$$f(x)=x^2$$\n\n![不自动加载的图片](https://evil.example/ai.png)\n\n<script>window.__aiExecuted=true</script>`,
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
  await page.getByRole('textbox', { name: '模型名称' }).fill('fixture-model')
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
  await expect(page.locator('.katex')).toBeVisible()
  await expect(page.getByRole('button', { name: '停止回答' })).toHaveCount(0)
  const context = JSON.parse(requests[0].messages[1].content!.split('\n').slice(1).join('\n'))
  expect(context.selection).toBe(selected)
  expect(JSON.stringify(requests[0])).not.toContain('想象你正在读一部历史书')
  expect(requests[1].messages.some((message) => message.role === 'tool')).toBe(true)
  expect(remoteRequests).toEqual([])
  expect(await page.evaluate(() => '__aiExecuted' in window)).toBe(false)
  await page.getByRole('button', { name: '原文', exact: true }).click()
  await expect(page.getByRole('dialog')).toContainText('实际提供的原文')
  await page.getByRole('button', { name: '定位原文' }).click()
  await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('追问：用自己的话再说一次。')
  await page.getByRole('button', { name: '发送问题' }).click()
  await expect(page.locator('.message-assistant')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '停止回答' })).toHaveCount(0)
  expect(
    JSON.parse(requests[2].messages[1].content!.split('\n').slice(1).join('\n')).snapshotId,
  ).toBe(context.snapshotId)
  expect(requests[2].messages.filter((message) => message.role === 'user')).toHaveLength(3)
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
  expect(await settingsStorage(page)).not.toContain('ephemeral-test-secret')
  await page.reload()
  await page.getByRole('button', { name: '打开设置' }).click()
  await expect(page.getByLabel('服务密钥', { exact: true })).toHaveValue('')
})
