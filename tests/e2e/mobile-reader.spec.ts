import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

async function openReader(page: Page) {
  const policy = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
  await page.route('http://127.0.0.1:1430/', async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'Content-Security-Policy': policy },
    })
  })
  await page.goto('/')
  await page.getByRole('button', { name: '开始阅读' }).click()
  await expect(page.locator('.reader-surface')).toBeVisible()
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().startsWith('blob:')).length)
    .toBeGreaterThan(0)
  return page.frames().find((frame) => frame.url().startsWith('blob:'))!
}

const currentCFI = (page: Page) =>
  page
    .locator('foliate-view')
    .evaluate((view) => (view as HTMLElement & { lastLocation: { cfi: string } }).lastLocation.cfi)

for (const viewport of [
  { width: 412, height: 915 },
  { width: 1000, height: 1400 },
]) {
  test.describe(`portrait touch reader ${viewport.width}`, () => {
    test.use({ viewport, isMobile: true, hasTouch: true })

    test('opening the assistant and resizing retain text geometry and the submitted selection', async ({
      page,
    }) => {
      let submittedSelection: string | undefined
      await page.route('**/fixture/v1/chat/completions', async (route) => {
        const body = route.request().postDataJSON()
        submittedSelection = JSON.parse(
          body.messages[1].content.split('\n').slice(1).join('\n'),
        ).selection
        await route.fulfill({
          contentType: 'text/event-stream',
          body: 'data: {"choices":[{"delta":{"content":"已收到选中原文。"}}]}\n\ndata: [DONE]\n\n',
        })
      })
      const frame = await openReader(page)
      await page.getByRole('button', { name: '模型设置' }).click()
      await page.getByRole('textbox', { name: '服务地址' }).fill('http://127.0.0.1:1430/fixture/v1')
      await page.getByLabel('服务密钥', { exact: true }).fill('synthetic-selection-test')
      await page.getByRole('button', { name: '保存设置' }).click()
      await page.getByRole('button', { name: '收起阅读伙伴' }).click()
      const bounds = await page.locator('.reader-host').boundingBox()
      const selected = await frame
        .locator('p')
        .first()
        .evaluate((paragraph) => {
          const range = paragraph.ownerDocument.createRange()
          range.selectNodeContents(paragraph)
          const selection = paragraph.ownerDocument.getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          paragraph.ownerDocument.dispatchEvent(new Event('selectionchange'))
          return selection.toString()
        })
      await page.getByRole('button', { name: '提问', exact: true }).click()
      await expect(page.locator('.selection-preview')).toContainText(selected.slice(0, 110))
      expect(await page.locator('.reader-host').boundingBox()).toEqual(bounds)
      // TOC and assistant together must not restore the desktop two-column rule.
      await page.getByRole('button', { name: '显示目录' }).click()
      expect(await page.locator('.reader-host').boundingBox()).toEqual(bounds)
      await page.getByRole('button', { name: '收起目录' }).click()
      await page.getByRole('textbox', { name: '向阅读伙伴提问' }).fill('解释所选原文。')
      await page.setViewportSize({ width: viewport.width, height: viewport.height - 150 })
      await expect(page.locator('.selection-preview')).toContainText(selected.slice(0, 110))
      await page.getByRole('button', { name: '发送问题' }).click()
      await expect(page.getByRole('dialog')).toContainText('发送前，看看会分享什么')
      await page.getByRole('button', { name: '允许此书会话发送' }).click()
      await expect(page.locator('.answer-markdown')).toContainText('已收到选中原文。')
      expect(submittedSelection).toBe(selected)
      await page.screenshot({ path: `.local/screenshots/alpha10-portrait-${viewport.width}.png` })
    })
  })
}

test.describe('touch selection navigation', () => {
  test.use({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true })

  test('selection dragging blocks engine auto-pagination and margin clicks; a fresh swipe turns once', async ({
    page,
  }) => {
    const frame = await openReader(page)
    await page.getByRole('button', { name: '收起阅读伙伴' }).click()
    const original = await currentCFI(page)
    await frame
      .locator('p')
      .first()
      .evaluate((paragraph) => {
        const doc = paragraph.ownerDocument
        const target = doc.documentElement
        const pointer = (type: string, x: number) =>
          doc.dispatchEvent(
            new PointerEvent(type, {
              pointerId: 1,
              isPrimary: true,
              pointerType: 'touch',
              clientX: x,
              clientY: 100,
              bubbles: true,
            }),
          )
        const touch = (type: string, x: number, end = false) => {
          const contact = new Touch({
            identifier: 1,
            target,
            clientX: x,
            clientY: 100,
            screenX: x,
            screenY: 100,
          })
          doc.dispatchEvent(
            new TouchEvent(type, {
              changedTouches: [contact],
              touches: end ? [] : [contact],
              bubbles: true,
              cancelable: true,
            }),
          )
        }
        pointer('pointerdown', 200)
        touch('touchstart', 200)
        const range = doc.createRange()
        range.selectNodeContents(doc.body)
        const selection = doc.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        doc.dispatchEvent(new Event('selectionchange'))
        pointer('pointermove', 20)
        touch('touchmove', 20)
        pointer('pointerup', 20)
        touch('touchend', 20, true)
      })
    await expect(page.locator('.selection-toolbar')).toBeVisible()
    // The upstream pointer-selection timer used to turn a page after 700ms.
    await page.waitForTimeout(1100)
    expect(await currentCFI(page)).toBe(original)
    await frame.evaluate(() => document.getSelection()?.removeAllRanges())
    await page.locator('.reader-surface').dispatchEvent('click', { clientX: 400, clientY: 200 })
    expect(await currentCFI(page)).toBe(original)
    await page.getByRole('button', { name: '取消选文' }).click()
    // Await the renderer's completed navigation, including its short transition lock.
    const expected = await page.locator('foliate-view').evaluate(async (element) => {
      const view = element as HTMLElement & {
        next(): Promise<void>
        prev(): Promise<void>
        lastLocation: { cfi: string }
      }
      await view.next()
      const next = view.lastLocation.cfi
      await view.prev()
      return next
    })
    expect(expected).not.toBe(original)
    await expect.poll(() => currentCFI(page)).toBe(original)
    const bounds = (await page.locator('.reader-host').boundingBox())!
    const cdp = await page.context().newCDPSession(page)
    const y = bounds.y + bounds.height / 2
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 330, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 210, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 80, y }] })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await expect.poll(() => currentCFI(page)).toBe(expected)
    await cdp.detach()
  })
})
