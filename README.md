# ReadWeave

**在原文旁理解，顺畅继续阅读。**

ReadWeave 是一个本地优先的开放 EPUB 阅读器，正式目标为 **Windows 11 与 Android 平板**。原始设计方案已完整保留在 [产品方案 v0.3](docs/product-plan-v0.3.zh-CN.md)。

当前为 `0.1.0-alpha.4`，处于 **P0 技术验证中**，已经具备可试用的阅读与问答原型，并完成首阶段原生阅读核心迁移。它还没有达到原方案的 v0.1 发布验收标准。

## 现在可以体验

- 导入无 DRM、可重排 EPUB，离线书架、目录、分页、字号、行距、三种主题和位置恢复。
- 正文最多 100,000 段，兼容 `&nbsp;` 等标准 HTML 命名实体；两本用户指定的本地书已完成导入 / 阅读 / 重开与原生保存验证，范围见 [EPUB 兼容性记录](docs/epub-compatibility.md)。
- 划线后提问、高亮和笔记；重选已有高亮可取消，不叠加重复高亮；点击书内标注查看、编辑或删除笔记。
- 可独立收起目录和阅读伙伴；全屏沉浸阅读，点击中间唤醒控件、两侧翻页；选文时保留标注操作。
- 连接自己的 Chat Completions 兼容模型服务，流式回答、追问、取消、数学排版和返回提问位置。
- DeepSeek 思考模式与低 / 高 / 最高强度、输出预算、流式思考过程；可展开的工具名称、参数、状态和结果。
- 冻结问题上下文；默认只提供截至提问位置的资料；首次发送前预览；两个受限书内工具与真实原文引用。
- 原生端由 Rust / SQLite 保存正文、冻结快照、检查身份 / 范围 / 预算并签发引用；重启后保留引用定位，读取授权重新创建。
- 声明式动作包的安装预览、启停、更新、回滚、卸载、导入与导出。
- 版本化 JSON 备份、原书哈希核对、恢复前备份与原子合并；Markdown 导出。
- 两本原创离线示例书，不使用预制 AI 回答。

Windows 原生端使用 Rust、SQLite 和本地书籍文件；浏览器预览使用 IndexedDB，两者的数据互不共享。浏览器清理可能删除预览数据，请保留备份。

## 启动

需要 Node.js 22.12 以上，推荐本次验证使用的 Node.js 24。项目采用 npm，运行依赖精确固定，提交 `package-lock.json` 和 `src-tauri/Cargo.lock`。

```powershell
npm ci
npm run dev
```

打开 `http://127.0.0.1:1420`。无需模型账号即可离线阅读两本示例书。

Windows 原生开发还需要 Rust 1.98 以上、Microsoft C++ Build Tools 和 WebView2：

```powershell
npm run desktop:dev
npm run desktop:build
```

本机生成的应用和安装包位于：

```text
src-tauri/target/release/readweave.exe
src-tauri/target/release/bundle/nsis/ReadWeave_0.1.0-alpha.4_x64-setup.exe
```

这是未签名的开发预览包。Windows 11 是产品目标，实际验收范围见 [验证记录](docs/validation.md)，不能将成功打包等同于完整平台验收。

首次升级旧数据库前会在数据库旁生成一致性 SQLite 备份，保留书籍、标注、问答与进度。迁移范围、回滚方式及来源校验边界见 [原生阅读核心](docs/native-reading-core.md)。

## 配置阅读伙伴

在“设置 → 模型连接”输入服务地址、模型名称和自己的密钥。服务地址可填 `https://你的服务/v1`；程序补全 `/chat/completions`。服务需要支持 SSE 流式响应和 function tools。

DeepSeek 默认建议模型为 `deepseek-flash`，也可选 `deepseek-v4-pro` 或填写自己的模型名称。选择“DeepSeek”服务类型后，可以开关思考模式、设置 `low / high / max` 强度和单次输出预算。思考过程与最终回答分别显示；工具调用可展开查看详情，保存的问答和 JSON 备份保留这些记录。旧配置的模型名称会保留，旧备份仍可读取。

适配依据为 2026-10-14 核对的 [DeepSeek 官方思考模式指南](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/) 和 [Chat Completions 接口](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)。工具循环和连续追问会完整回传保留回合的 `reasoning_content`、工具调用与结果；超过上下文大小上限会提示开启新话题。其他兼容服务不发送 DeepSeek 专有参数。详细范围见 [DeepSeek 适配记录](docs/deepseek.md)。

远程服务只接受 HTTPS。无需密钥的本机开发服务可以使用 `http://127.0.0.1:端口/v1`。浏览器预览需要服务允许跨域，本机服务还可能需要浏览器的本地网络许可；原生客户端通过 Rust 请求，不依赖浏览器 CORS。

**密钥当前只在进程内存中使用，关闭后清除。** 不写入 localStorage、IndexedDB、SQLite、日志或默认备份。原方案要求的跨平台安全凭据持久化尚未验证，因此暂不提供“记住密钥”。内置后端已实现真实请求路径，但双服务商业模型验收尚未执行；自动化测试使用本机协议测试服务。

每次启动重新填写是当前预览版的功能缺口，长期需要系统保护的“记住密钥”与清除入口。用户反馈后已将安全凭据保存列为优先的日常使用工作；平台实现及验收建议见 [兼容性与日常使用](docs/epub-compatibility.md)。

未连接模型时不会生成解释，不会将示例文字伪装成 AI 回答。划线本身不会发送资料。联网搜索和外部 Harness 目前没有启用。

## 在书内操作

- 选中原文后点击“高亮”；重选该范围或其中一部分，按钮变为“取消高亮”，会移除与选文相交的高亮，笔记继续保留。直接点击黄色高亮或笔记下划线，可以在原文旁操作。
- “本书标注”只列出当前书籍版本的高亮、笔记和书签。点击条目返回书内；外部“阅读笔记”仍用于跨书汇总和导出。
- 点击“全屏阅读”收起所有面板和控件。中间单击唤醒，再点中间或“继续沉浸”收起；鼠标点击两侧边距、触摸左右区域或按左右方向键翻页。鼠标在正文内优先选词，拖选和长按不会触发点击翻页，已有标注优先打开标注卡片。
- “退出全屏阅读”或 Escape 返回普通阅读，并恢复进入前的目录 / 阅读伙伴开关。键盘 Tab 可找到“显示阅读控件”入口。

## 动作包

在“阅读动作”中安装 JSON 文件。可以先试用 [历史阅读释义](examples/history-reading.json)。提示模板仅支持 `{{selection}}`、`{{title}}`、`{{chapter}}`、`{{question}}` 的字面替换，不执行表达式或代码。

包不能添加网络、文件或密钥权限。同一 ID 的包不会静默替换，需要预览确认，并保留上一版本用于回滚。这不等于验证了发布者身份。卸载动作包会保留用户笔记和问答。

## 验证与开发

```powershell
npm run check
npm run test:e2e
cargo test --manifest-path src-tauri/Cargo.toml --locked
cargo fmt --manifest-path src-tauri/Cargo.toml --check
```

浏览器测试使用本机 Microsoft Edge，针对生产构建，在独立的 `1430` 端口运行，覆盖阅读与数据流程、流式工具循环和内容安全策略。测试数据与真实服务凭据无关。

```text
src/components/       书架、笔记、设置、动作包和阅读伙伴
src/reader/           ReaderAdapter、EPUB 导入、清理、定位与渲染
src/core/             数据类型、异步阅读服务 / 预览后端、动作包、备份和存储
src/harness/          HarnessAdapter、ProviderAdapter、流式执行循环
src/vendor/foliate/   固定提交的阅读引擎、原许可和补丁说明
src-tauri/            原生阅读核心、权限 / 引用、数据库迁移、文件与网络
examples/             可安装的声明式动作包
tests/                契约、安全和浏览器流程测试
docs/                 原方案、工程决策、验证记录和开发计划
```

阅读引擎固定到 foliate-js 提交 `78914aef4466eb960965702401634c2cb348e9b1`，包含三组可复现补丁，见 [VENDOR.md](src/vendor/foliate/VENDOR.md)。数学依赖统一使用已修复旧版本问题的 KaTeX，锁文件避免嵌套依赖退回旧版。

## 尚未完成

- Android SDK / NDK 构建和 Android 真机的连续选区、旋转、键盘、面板与安装验收。配置暂以 Android 12 / API 31 为起点；WebView 最低版本仍需实测确定。
- 两个真实模型服务验收，以及真实 Hermes ACP、Connector、MCP / rmcp 的双向接入。
- 统一任务生命周期和适配器注册入口。原生权限与取证已接入当前内置问答；外部调用身份、MCP 配对与授权仍待验证。
- SQLite FTS5、中文预分词、分段索引状态。当前受限文本扫描明确返回 `indexStatus: scan`，不伪装成已完成的全文索引。
- 凭据安全持久化、数据库迁移 / 故障恢复长期验收、复杂 EPUB 样本与完整定位回退。
- PDF / OCR、图片公式识别、联网搜索、可执行插件和云同步。

EPUB 当前移除出版物 CSS、SVG 和主动内容，采用统一排版。复杂版式可能损失表现；标准文本与基础 MathML 路径仍需更多真实书籍样本验证。定位主要依赖清理后的 CFI，歧义文本不会自动跳转。参见 [开发计划](docs/roadmap.md)。

本轮实施清单见 [原生核心计划](docs/native-core-plan.md)。Android 真机工作按用户要求暂缓；下一阶段先抽出统一任务与适配器入口，再接一个真实外部 Harness。

## 许可

自研代码采用 [Apache-2.0](LICENSE)，foliate-js 保留 MIT 许可，原创示例书采用 CC0 1.0。其他依赖遵守各自许可，见 `THIRD_PARTY_NOTICES.txt`。项目没有官方账号、强制订阅或遥测。
