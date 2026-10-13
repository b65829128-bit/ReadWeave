import { mkdir, writeFile } from 'node:fs/promises'
import { strToU8, zipSync } from 'fflate'

const samples = [
  {
    file: 'understanding.epub',
    title: '理解的线索',
    author: 'ReadWeave',
    subtitle: '关于阅读、提问与好奇心的三封短信',
    chapters: [
      {
        title: '第一章 · 把一个问题留在书页旁',
        paragraphs: [
          '阅读最动人的时刻，有时不是读懂了一句话，而是突然意识到：这句话，我还没有真正理解。',
          '你也许认得每一个字，却说不清它们为什么被放在一起。你也许记住了结论，却无法解释结论是怎样得到的。这不意味着阅读失败了。疑问恰好是理解的入口。',
          '想象你正在读一部历史书。书中出现一个熟悉的官职，熟悉到你差点一眼略过。可当你停下来追问，它在这个时代究竟负责什么，你便开始把一个抽象的名称，放回具体的人、制度与事件之中。',
          '一个好问题往往很小。它不必是“告诉我这个时代的全部历史”，而可以是“这里为什么选择这个人”“这个词在当时是什么意思”“这件事和前面那件事有什么关系”。问题越贴近原句，回答越容易真正帮助你继续阅读。',
          '技术书也一样。面对一条公式，与其请求重讲整章，不如指出使你迟疑的那个符号：它代表什么？这一行到下一行省略了哪一步？如果换一个具体的数字，结论还成立吗？',
          '解释应该是一座短桥：把你从暂时不懂的地方，送回仍然想读下去的原文。它可以提供背景、例子或推导，但不必抢走阅读的中心。',
          '读到这里，可以试着选中一句话，点击“解释一下”。ReadWeave 会保留这段选文和当时的位置。你可以翻到后面，回答仍然围绕你刚才的问题。',
          '如果尚未连接模型，右侧会提示你完成配置。示例书可以离线阅读；应用不会把预设文字伪装成 AI 回答，也不会因为划线就自动发送内容。',
          '在默认设置中，可供取证的正文到提问位置为止。这能约束应用提供的资料，但不能消除模型已经知道的故事结局或外部背景。需要特别避免剧透时，问题本身也可以明确这一点。',
          '读完解释后，再回到那句话。现在你能用自己的话说出它的意思吗？如果可以，就继续读；如果仍有一个地方模糊，就把问题再缩小一点。理解常常就是这样逐渐变得清楚的。',
        ],
      },
      {
        title: '第二章 · 从答案回到依据',
        paragraphs: [
          '一段解释读起来顺畅，并不意味着它一定正确。流畅是一种表达能力，可靠则需要另一种检验。',
          '当回答声称“书中说”时，最直接的检验是回到原句。引用应当能带你找到实际存在的文字，而不是只给出一个看起来像来源的编号。',
          '定位成功也只完成了第一步。接下来还要看，这段原文是否真的支持回答中的那个判断。作者说了一个事实，解释却可能多走了一步，把推测当成了因果。',
          '因此，阅读伙伴应当区分三种声音：书里明确写下的内容，外部资料补充的背景，以及根据已有信息做出的解释或推断。三者都可能有用，但它们的依据不同。',
          '例如，一个历史人物获得任命，是书内可以核对的记载；某个官职通常承担的职责，可能需要可靠的制度史资料；任命背后的个人动机，则未必能仅凭这句话确定。',
          '技术阅读中的例子也有适用范围。一个二维图形可以帮助你理解梯度，却不能代替所有高维情形的证明。好例子应当说明它展示了什么，也说明它省略了什么。',
          '当资料不足时，最有帮助的回答可能是一句简短的澄清：“你说的是哪个时期？”或者“公式右边的那个下标在图片里吗？”承认缺失，比编造完整更接近理解。',
          '把值得保留的解释写成笔记时，可以再加一句自己的话。比如“我原来把变化最快的方向和下降方向混淆了”。这样的笔记记录的不只是答案，也记录了理解发生变化的地方。',
        ],
      },
      {
        title: '第三章 · 继续阅读',
        paragraphs: [
          '不是每一处不懂都要立刻解决。有些问题会在后面的段落中自然展开，有些则值得当场停下来。读者应当保留这个选择。',
          '工具的作用，是在你需要时降低追问的成本。它不必不断提醒你还有多少知识尚未掌握，也不必把一次提问延伸成一条没有尽头的推荐列表。',
          '你可以关闭回答面板，只留下书页。也可以留下一个书签，等有时间时再回来。阅读进度、标注与笔记都属于你，而不是属于某一次模型会话。',
          '把一个问题解决到足以继续阅读，通常比把相关知识全部展开更合适。今天留下的小小理解，会在下一次阅读中和新的内容相遇。',
          '这本小书的文字由 ReadWeave 项目原创，用于验证阅读、定位与提问流程。它不是对学习效果的研究结论。真正的体验，需要你在自己的书里慢慢检验。',
          '愿每一次好奇，都有一个可以停靠的地方。也愿每一次解释，都把你温柔地送回文字之中。',
        ],
      },
    ],
  },
  {
    file: 'gradient.epub',
    title: '梯度下降的第一步',
    author: 'ReadWeave',
    subtitle: '从坡度的直觉，到更新的方向',
    chapters: [
      {
        title: '第一章 · 为什么要往反方向走',
        paragraphs: [
          '假设我们想让函数 f(x) = x² 的值尽可能小。横轴上的 x 是可以调整的参数，纵轴上的 f(x) 表示我们希望减小的损失。',
          '当 x = 2 时，函数值是 4。此时导数 f′(x) = 2x = 4。导数为正，意味着在足够小的局部范围内，增大 x 会使函数值增大。',
          '既然我们想让函数值减小，就可以朝相反方向移动：减小 x。这便是“沿负梯度方向更新”的一维直觉。',
          '梯度下降的更新公式是 x_new = x_old − η f′(x_old)。其中 η 是学习率，用来控制每一步走多远。',
          '取学习率 η = 0.1，从 x = 2 开始，下一步得到 x_new = 2 − 0.1 × 4 = 1.6。新的函数值是 2.56，比原来的 4 小。',
          '再走一步，导数变为 3.2，得到 x_new = 1.6 − 0.1 × 3.2 = 1.28。函数值继续减小。这里的每一步都重新计算当前位置的导数。',
          '“负梯度是下降方向”来自局部的一阶近似：f(x + Δx) 约等于 f(x) + f′(x)Δx。让 Δx = −η f′(x)，线性项便成为 −η[f′(x)]²，不大于零。',
          '请留意“一阶近似”和“足够小”的条件。步长过大时，被忽略的高阶变化可能占主导，实际函数值并不一定下降。',
          '例如，从 x = 2 出发，若 η = 1.1，更新后 x = −2.4，函数值为 5.76，反而比原来更大。方向在局部正确，并不保证任何步长都有效。',
          '这份示例使用可解析文本公式，不包含扫描页识别。如果你的教材把关键公式放在图片里，当前原型不会识别其中的符号。',
        ],
      },
      {
        title: '第二章 · 当参数不止一个',
        paragraphs: [
          '多个参数组成向量 θ 时，梯度 ∇f(θ) 收集了各个参数方向上的偏导数。更新写成 θ_new = θ_old − η∇f(θ_old)。',
          '在欧几里得距离和固定步长长度的约束下，负梯度给出一阶近似中下降最快的方向。这个表述依赖我们采用的距离度量与局部近似。',
          '对于 f(x, y) = x² + 2y²，梯度是 (2x, 4y)。在点 (1, 1) 处，负梯度为 (−2, −4)。它告诉我们两个参数都应减小，但 y 方向的局部变化更陡。',
          '实际模型的损失函数通常比这个例子复杂，可能包含鞍点、平坦区域或多个局部极小值。基础梯度下降并不保证找到任意非凸函数的全局最优解。',
          '理解一个更新公式时，可以依次问四个问题：什么量可以调整？我们想减小什么？梯度在哪里计算？步长为什么这样选择？',
          '先把这四个问题回答清楚，再学习动量、自适应学习率或随机梯度，新的方法就更容易和已有直觉连接起来。',
        ],
      },
    ],
  },
]

const escape = (text) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
await mkdir('public/samples', { recursive: true })
for (const book of samples) {
  const files = {
    mimetype: [strToU8('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    ),
    'EPUB/package.opf': strToU8(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:readweave:${book.file}</dc:identifier><dc:title>${book.title}</dc:title><dc:creator>${book.author}</dc:creator><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-10-13T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>${book.chapters.map((_, i) => `<item id="c${i}" href="chapter-${i}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest><spine>${book.chapters.map((_, i) => `<itemref idref="c${i}"/>`).join('')}</spine></package>`,
    ),
    'EPUB/nav.xhtml': strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol>${book.chapters.map((c, i) => `<li><a href="chapter-${i}.xhtml">${c.title}</a></li>`).join('')}</ol></nav></body></html>`,
    ),
  }
  for (const [i, chapter] of book.chapters.entries())
    files[`EPUB/chapter-${i}.xhtml`] = strToU8(
      `<html xmlns="http://www.w3.org/1999/xhtml" lang="zh-CN"><head><title>${chapter.title}</title></head><body><h1>${chapter.title}</h1>${chapter.paragraphs.map((p) => `<p>${escape(p)}</p>`).join('')}</body></html>`,
    )
  await writeFile(
    `public/samples/${book.file}`,
    zipSync(files, { level: 6, mtime: new Date('2026-10-13T00:00:00Z') }),
  )
}
console.log('Generated two original EPUB samples.')
