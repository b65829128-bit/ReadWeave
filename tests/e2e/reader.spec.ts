import { test, expect, type Page, type Frame } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'

test.beforeEach(async ({ page }) => {
  const policy = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).app.security.csp
  await page.route('http://127.0.0.1:1430/', async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'Content-Security-Policy': policy },
    })
  })
})

async function boot(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('button', { name: '开始阅读' })).toBeVisible()
  await expect(page.locator('.book-card')).toHaveCount(2)
}
async function openSample(page: Page): Promise<Frame> {
  await page.getByRole('button', { name: /^(开始阅读|继续阅读)$/ }).click()
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  await expect
    .poll(() => page.frames().filter((frame) => frame.url().startsWith('blob:')).length)
    .toBeGreaterThan(0)
  return page.frames().find((frame) => frame.url().startsWith('blob:'))!
}
async function selectFirstParagraph(frame: Frame) {
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
}
async function annotationRecords(page: Page): Promise<{ kind: string; note: string }[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('readweave', 1)
      request.onsuccess = () => resolve(request.result)
    })
    return new Promise((resolve) => {
      const request = db.transaction('annotations').objectStore('annotations').getAll()
      request.onsuccess = () => {
        resolve(request.result)
        db.close()
      }
    })
  })
}

test('highlights toggle, existing notes open in the book and can be edited or removed', async ({
  page,
}) => {
  await boot(page)
  const frame = await openSample(page)
  const original = (await readBooks(page)).find((book) => book.position)!.position!.cfi
  await frame
    .locator('p')
    .first()
    .dblclick({ position: { x: 35, y: 18 } })
  await expect(page.locator('.selection-toolbar')).toBeVisible()
  expect((await readBooks(page)).find((book) => book.position)!.position!.cfi).toBe(original)
  await page.getByRole('button', { name: '取消选文' }).click()
  await selectFirstParagraph(frame)
  await page.getByRole('button', { name: '高亮', exact: true }).click()
  await expect(page.getByRole('button', { name: '取消高亮', exact: true })).toBeVisible()
  await selectFirstParagraph(frame)
  await page.getByRole('button', { name: '取消高亮', exact: true }).click()
  await expect.poll(async () => (await annotationRecords(page)).length).toBe(0)
  await page.getByRole('button', { name: '高亮', exact: true }).click()
  await page.getByRole('button', { name: '笔记', exact: true }).click()
  await page.getByLabel('我的笔记').fill('第一次的理解')
  await page.getByRole('button', { name: '保存笔记', exact: true }).click()
  await page.getByRole('button', { name: '取消选文' }).click()
  await frame
    .locator('p')
    .first()
    .click({ position: { x: 20, y: 10 } })
  await expect(page.getByRole('complementary', { name: '原文标注' })).toContainText('第一次的理解')
  await page.getByRole('button', { name: '编辑笔记', exact: true }).click()
  await page.getByLabel('我的笔记').fill('修正后的理解😀')
  await page.getByRole('button', { name: '保存笔记', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '原文标注' })).toContainText(
    '修正后的理解😀',
  )
  await page.screenshot({ path: '.local/screenshots/book-notes.png', fullPage: true })
  await page.getByRole('button', { name: '取消高亮', exact: true }).click()
  await expect
    .poll(async () => (await annotationRecords(page)).map((a) => a.kind))
    .toEqual(['note'])
  await page.getByRole('button', { name: '删除笔记', exact: true }).click()
  await expect.poll(async () => (await annotationRecords(page)).length).toBe(0)
  await page.getByRole('button', { name: '关闭原文标注' }).click()
  await page.getByRole('button', { name: '本书标注', exact: true }).click()
  await expect(page.getByRole('complementary', { name: '本书标注' })).toContainText(
    '选中原文即可高亮或记笔记',
  )
  await page.getByRole('button', { name: '收起本书标注' }).click()
  await expect(page.locator('.in-reader')).toBeVisible()
})

test('every reader panel closes, fullscreen wakes on a center tap and edges turn pages', async ({
  page,
}) => {
  await boot(page)
  await openSample(page)
  await page.getByRole('button', { name: '收起目录' }).click()
  await expect(page.getByRole('complementary', { name: '书籍目录' })).toHaveCount(0)
  await page.getByRole('button', { name: '收起阅读伙伴' }).click()
  await expect(page.getByRole('complementary', { name: '阅读伙伴' })).toHaveCount(0)
  await page.getByRole('button', { name: '全屏阅读', exact: true }).click()
  await expect(page.locator('.app.immersive')).toBeVisible()
  await expect(page.locator('.reader-header')).toHaveCount(0)
  await expect(page.locator('.reading-footer')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  await page.screenshot({ path: '.local/screenshots/immersive.png', fullPage: true })
  await expect
    .poll(() =>
      page
        .locator('.reader-host')
        .evaluate((element) => Math.round(element.getBoundingClientRect().height)),
    )
    .toBe(await page.evaluate(() => innerHeight))
  const frame = page.frames().find((item) => item.url().startsWith('blob:'))!
  const host = await page.locator('.reader-host').boundingBox()
  await page.mouse.click(host!.x + host!.width / 2, host!.y + host!.height / 2)
  await expect(page.getByRole('button', { name: '退出全屏阅读' })).toBeVisible()
  await page.getByRole('button', { name: '继续沉浸', exact: true }).click()
  await selectFirstParagraph(frame)
  await expect(page.getByRole('button', { name: '高亮', exact: true })).toBeVisible()
  await expect(page.locator('.reader-header')).toHaveCount(0)
  await page.getByRole('button', { name: '取消选文' }).click()
  const before = (await readBooks(page)).find((book) => book.position)!.position!.cfi
  await page.mouse.click(host!.x + host!.width * 0.9, host!.y + host!.height / 2)
  await expect
    .poll(async () => (await readBooks(page)).find((book) => book.position)!.position!.cfi)
    .not.toBe(before)
  await page.mouse.click(host!.x + host!.width / 2, host!.y + host!.height / 2)
  await page.getByRole('button', { name: '退出全屏阅读' }).click()
  await expect(page.locator('.app.immersive')).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
})
async function readBooks(
  page: Page,
): Promise<{ id: string; position?: { cfi: string; paragraphId: string; endOffset: number } }[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('readweave', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    return new Promise((resolve, reject) => {
      const request = db.transaction('books').objectStore('books').getAll()
      request.onsuccess = () => {
        resolve(request.result)
        db.close()
      }
      request.onerror = () => reject(request.error)
    })
  })
}

test('offline library, EPUB selection, notes, pagination, position restore and exports', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await boot(page)
  await page.screenshot({ path: '.local/screenshots/library.png', fullPage: true })
  const frame = await openSample(page)
  await expect(frame.locator('h1')).toContainText('第一章')
  await selectFirstParagraph(frame)
  await expect(page.getByRole('button', { name: '高亮', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '高亮', exact: true }).click()
  await page.getByRole('button', { name: '笔记', exact: true }).click()
  await page.getByPlaceholder('用自己的话，说说你理解了什么…').fill('一个好问题应贴近原句。😀')
  await page.getByRole('button', { name: '保存笔记', exact: true }).click()
  await page.getByRole('button', { name: '添加书签' }).click()
  const before = (await readBooks(page)).find((book) => book.position)!.position!.cfi
  await page.getByRole('button', { name: '下一页' }).click()
  await expect
    .poll(async () => (await readBooks(page)).find((book) => book.position)!.position!.cfi)
    .not.toBe(before)
  const after = (await readBooks(page)).find((book) => book.position)!.position!.cfi
  await page.getByRole('button', { name: '阅读排版' }).click()
  await page.getByRole('slider', { name: '正文字号' }).fill('23')
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.screenshot({ path: '.local/screenshots/reader.png', fullPage: true })
  await page.getByRole('button', { name: '返回书架' }).click()
  await page.getByRole('button', { name: '阅读笔记', exact: true }).click()
  await expect(page.locator('.note-card')).toHaveCount(3)
  await expect(page.getByText('一个好问题应贴近原句。😀')).toBeVisible()
  const exported = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 Markdown' }).click()
  expect((await exported).suggestedFilename()).toMatch(/\.md$/)
  await page.reload()
  await expect(page.getByRole('button', { name: '继续阅读' })).toBeVisible()
  const reopened = await openSample(page)
  await expect(reopened.locator('body')).toContainText('理解')
  const restored = (await readBooks(page)).find((book) => book.position)!.position!
  expect(restored.cfi).not.toBe(before)
  expect(after).toBeTruthy()
  expect(errors).toEqual([])
})

test('declarative action pack install, disable, upgrade, rollback and uninstall preserve notes', async ({
  page,
}) => {
  await boot(page)
  await page.getByRole('button', { name: '阅读动作', exact: true }).click()
  const pack = JSON.parse(readFileSync('examples/history-reading.json', 'utf8'))
  const upload = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '安装动作包', exact: true }).click()
  await (
    await upload
  ).setFiles({
    name: 'history.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(pack)),
  })
  await expect(page.getByRole('dialog')).toContainText('历史阅读释义')
  await page.getByRole('dialog').getByRole('button', { name: '安装动作包', exact: true }).click()
  const enabled = page.getByRole('checkbox', { name: '启用历史阅读释义' })
  await expect(enabled).toBeChecked()
  await enabled.uncheck()
  await expect(enabled).not.toBeChecked()
  const upgrade = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '安装动作包', exact: true }).click()
  await (
    await upgrade
  ).setFiles({
    name: 'history-v2.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...pack, version: '0.2.0' })),
  })
  await page.getByRole('button', { name: '确认替换，可回滚' }).click()
  await expect(page.locator('.pack-card').filter({ hasText: '历史阅读释义' })).toContainText(
    'v0.2.0',
  )
  await page.getByRole('button', { name: '回滚', exact: true }).click()
  await expect(page.locator('.pack-card').filter({ hasText: '历史阅读释义' })).toContainText(
    'v0.1.0',
  )
  await expect(enabled).not.toBeChecked()
  await page.getByRole('button', { name: '卸载历史阅读释义' }).click()
  await page.getByRole('dialog').getByRole('button', { name: '卸载动作包', exact: true }).click()
  await expect(page.locator('.pack-card')).toHaveCount(1)
})

test('malicious EPUB cannot run scripts, set locators or make remote requests', async ({
  page,
}) => {
  await boot(page)
  const attempted: string[] = []
  page.on('request', (request) => {
    if (request.url().includes('evil.example')) attempted.push(request.url())
  })
  const files = unzipSync(new Uint8Array(readFileSync('public/samples/understanding.epub')))
  let chapter = strFromU8(files['EPUB/chapter-0.xhtml'])
  chapter = chapter.replace(
    '<body>',
    '<body onload="parent.__epubExecuted = true"><script>parent.__epubExecuted = true</script><img src="https://evil.example/track"/><iframe src="https://evil.example/frame"/><style>@import "https://evil.example/css";</style><a href="java&NewLine;script:parent.__epubExecuted=true">bad</a><p>甲&nbsp;乙&mdash;兼容实体</p>',
  )
  files['EPUB/chapter-0.xhtml'] = strToU8(chapter)
  const upload = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '导入书籍', exact: true }).click()
  await (
    await upload
  ).setFiles({
    name: 'malicious.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(zipSync(files)),
  })
  await expect(page.locator('.reader-header')).toBeVisible()
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  const frame = page.frames().find((frame) => frame.url().startsWith('blob:'))!
  await expect(frame.locator('script,iframe')).toHaveCount(0)
  expect(await frame.locator('style').allTextContents()).not.toEqual(
    expect.arrayContaining([expect.stringContaining('evil.example')]),
  )
  expect(await page.evaluate(() => '__epubExecuted' in window)).toBe(false)
  expect(attempted).toEqual([])
  await expect(frame.locator('body')).not.toHaveAttribute('onload')
  await expect(frame.locator('img')).not.toHaveAttribute('src')
  await expect(frame.locator('p').first()).toHaveText('甲\u00a0乙—兼容实体')
})

test('imports and reopens a book with more than fifty thousand paragraphs', async ({ page }) => {
  test.setTimeout(90_000)
  await boot(page)
  const sections = 102
  const files: Record<string, Uint8Array> = {
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(
      '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'EPUB/package.opf': strToU8(
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:readweave:large-regression</dc:identifier><dc:title>多段落兼容回归</dc:title><dc:language>zh-CN</dc:language></metadata><manifest>${Array.from({ length: sections }, (_, i) => `<item id="c${i}" href="chapter-${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${Array.from({ length: sections }, (_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`,
    ),
  }
  for (let section = 0; section < sections; section++)
    files[`EPUB/chapter-${section}.xhtml`] = strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第 ${section + 1} 节</title></head><body>${Array.from({ length: 500 }, (_, i) => `<p>这是第 ${section * 500 + i + 1} 段正文。</p>`).join('')}</body></html>`,
    )
  await page.locator('input[accept^=".epub"]').setInputFiles({
    name: 'many-paragraphs.epub',
    mimeType: 'application/epub+zip',
    buffer: Buffer.from(zipSync(files)),
  })
  await expect(page.locator('.reader-header')).toContainText('多段落兼容回归', {
    timeout: 60_000,
  })
  await expect(page.locator('.reader-loading')).toHaveCount(0)
  const frame = page.frames().find((item) => item.url().startsWith('blob:'))!
  await expect(frame.locator('p').first()).toHaveText('这是第 1 段正文。')
  await page.reload()
  await expect(page.locator('.book-card')).toHaveCount(3)
  await page.locator('.book-card').filter({ hasText: '多段落兼容回归' }).click()
  await expect(page.locator('.reader-header')).toContainText('多段落兼容回归', {
    timeout: 60_000,
  })
  await expect(page.locator('.reader-loading')).toHaveCount(0)
})

test('portrait tablet keeps the reader usable with an adjustable bottom answer panel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 1024 })
  await boot(page)
  const frame = await openSample(page)
  await expect(frame.locator('h1')).toBeVisible()
  await expect(page.getByRole('separator', { name: '调整回答面板高度' })).toBeVisible()
  const panel = page.getByRole('complementary', { name: '阅读伙伴' })
  const before = await panel.boundingBox()
  await page.getByRole('button', { name: '缩小', exact: true }).click()
  const after = await panel.boundingBox()
  expect(after!.height).toBeLessThan(before!.height)
  await page.getByRole('button', { name: '收起阅读伙伴' }).click()
  await expect(panel).toHaveCount(0)
  await page.getByRole('button', { name: '阅读伙伴', exact: true }).click()
  await page.screenshot({ path: '.local/screenshots/tablet.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
})

test('versioned JSON backup includes original books and restores a removed note', async ({
  page,
}) => {
  await boot(page)
  const frame = await openSample(page)
  await selectFirstParagraph(frame)
  await page.getByRole('button', { name: '笔记', exact: true }).click()
  await page.getByPlaceholder('用自己的话，说说你理解了什么…').fill('备份与恢复测试笔记。')
  await page.getByRole('button', { name: '保存笔记', exact: true }).click()
  await page.getByRole('button', { name: '返回书架' }).click()
  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByRole('button', { name: '数据与备份', exact: true }).click()
  await page.getByRole('checkbox', { name: /JSON 备份包含原始/ }).check()
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出 JSON 备份' }).click()
  const path = await (await download).path()
  const text = readFileSync(path!, 'utf8')
  const backup = JSON.parse(text)
  expect(backup.schemaVersion).toBe(1)
  expect(Object.keys(backup.originals)).toHaveLength(2)
  expect(backup.annotations).toHaveLength(1)
  expect(backup.model).not.toHaveProperty('apiKey')
  await page.getByRole('button', { name: '关闭对话框' }).click()
  await page.getByRole('button', { name: '阅读笔记', exact: true }).click()
  await page.getByRole('button', { name: '删除这条标注' }).click()
  await expect(page.locator('.note-card')).toHaveCount(0)
  await page.getByRole('button', { name: '打开设置' }).click()
  await page.getByRole('button', { name: '数据与备份', exact: true }).click()
  const upload = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '从备份恢复' }).click()
  await (
    await upload
  ).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(text) })
  await page.getByRole('button', { name: '先备份，再恢复' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: '阅读笔记', exact: true }).click()
  await expect(page.locator('.note-card')).toHaveCount(1)
  await expect(page.getByText('备份与恢复测试笔记。')).toBeVisible()
})
