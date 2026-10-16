# ReadWeave

**在原文旁理解，顺畅继续阅读。**

ReadWeave 是一个本地优先的开放 EPUB 阅读器，正式目标为 **Windows 11 与 Android 平板**。原始设计方案已完整保留在 [产品方案 v0.3](docs/product-plan-v0.3.zh-CN.md)。

当前为 `0.1.0-alpha.11`，处于 **P0 技术验证中**，已经具备可试用的阅读与问答原型，原生阅读核心和内置问答的统一任务入口已经接入。它还没有达到原方案的 v0.1 发布验收标准。

## 现在可以体验

- 导入无 DRM、可重排 EPUB，离线书架、目录、分页、字号、行距、三种主题和位置恢复。
- 正文最多 100,000 段，兼容 `&nbsp;` 等标准 HTML 命名实体；两本用户指定的本地书已完成导入 / 阅读 / 重开与原生保存验证，范围见 [EPUB 兼容性记录](docs/epub-compatibility.md)。
- 大书导入只解析一次，同次运行中重开当前书复用已校验内容并保留最新位置。《资治通鉴》的实测与验证范围见 [大书性能记录](docs/epub-performance.md)。
- 划线后提问、高亮和笔记；重选已有高亮可取消，不叠加重复高亮；点击书内标注查看、编辑或删除笔记。
- 可独立收起目录和阅读伙伴；全屏沉浸阅读，点击中间唤醒控件、两侧翻页；选文时保留标注操作。
- 触摸选区拖动时拦截翻页；手机和触摸平板竖屏使用覆盖式回答面板，打开面板不压缩正文，排版或可用高度变化后仍保留所选原文。
- Android 原生选区手柄拖动时保持整页位置，正常慢滑可翻页；软键盘出现时输入框和发送按钮保持可见，面板位置不随键盘改变屏幕可用高度而切换。
- 连接自己的 Chat Completions 兼容模型服务，流式回答、追问、取消、数学排版和返回提问位置。
- 统一管理问答准备、发送确认、取消和有序保存；换书或停用后端后，旧轮次不会继续改写当前回答。设置中可停用阅读伙伴，重启后保持。
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
src-tauri/target/release/bundle/nsis/ReadWeave_0.1.0-alpha.11_x64-setup.exe
```

Android arm64 alpha.11 测试 APK 位于 `.local/ReadWeave-alpha.11.apk`，Windows 直接运行包位于 `.local/ReadWeave-alpha.11.exe`。本轮已在 Android 16 / WebView 138 真机复现并修正慢滑失效、原生选区手柄导致半页偏移和键盘遮挡；诊断副本验证整页边界及横竖屏键盘，正式 APK 已安装并检查书架和键盘界面。真实模型引用和长时间阅读仍待继续验收。APK 使用 Android Debug 开发证书，release 应用调试已关闭。文件校验值和实际范围见 [验证记录](docs/validation.md)。

Windows 包是未签名的开发预览包。实际验收范围见 [验证记录](docs/validation.md)，不能将成功打包等同于完整平台验收。

Windows 启动失败会显示“ReadWeave 启动诊断”，列出具体步骤和错误代码；安装目录可写时，还会在 EXE 旁留下 `ReadWeave-startup-error.log`。报告仅包含应用版本、固定步骤、错误代码和静态说明，不包含书籍、模型设置或密钥。界面缓存使用独立的 `webview-v1` 目录，书籍与记录继续使用原来的本地存储。

本机 alpha.3 / alpha.4 / alpha.5 的秒退已定位为生成 EXE 继承构建目录的 Low 完整性标记，导致无法写入用户数据。当前本地交付文件已修正为正常用户的 Medium 标记，alpha.5 已实际恢复书架，旧记录完整保留。用户确认《资治通鉴》在 Windows 应用中导入成功，性能问题仍待排查；打包流程的自动检查尚待补齐，详情见验证记录。

alpha.6 已处理该书导入和打开时的主要耗时；随后用户日常双击启动仍遇到所有书保存失败。alpha.7 已确认实际使用的数据库损坏，完成保留原库备份的数据恢复，并增加启动前完整性检查及按原因区分的存储错误。测试环境与资源管理器的数据视图差异、恢复范围及实际验收见 [数据库修复记录](docs/storage-recovery.md)。当前本机交付文件继续核对 Medium 标记。

首次升级旧数据库前会在数据库旁生成一致性 SQLite 备份，保留书籍、标注、问答与进度。迁移范围、回滚方式及来源校验边界见 [原生阅读核心](docs/native-reading-core.md)。

## 配置阅读伙伴

在“设置 → 模型连接”输入服务地址、模型名称和自己的密钥。服务地址可填 `https://你的服务/v1`；程序补全 `/chat/completions`。服务需要支持 SSE 流式响应和 function tools。

取消勾选“启用阅读伙伴”会停止当前回答并撤销该话题的读取授权，保留模型设置和系统密钥。重新启用后，新话题再次预览要发送的资料。

DeepSeek 默认建议模型为 `deepseek-flash`，也可选 `deepseek-v4-pro` 或填写自己的模型名称。选择“DeepSeek”服务类型后，可以开关思考模式、设置 `low / high / max` 强度和单次输出预算。思考过程与最终回答分别显示；工具调用可展开查看详情，保存的问答和 JSON 备份保留这些记录。旧配置的模型名称会保留，旧备份仍可读取。

适配依据为 2026-10-14 核对的 [DeepSeek 官方思考模式指南](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode/) 和 [Chat Completions 接口](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion/)。工具循环和连续追问会完整回传保留回合的 `reasoning_content`、工具调用与结果；超过上下文大小上限会提示开启新话题。其他兼容服务不发送 DeepSeek 专有参数。详细范围见 [DeepSeek 适配记录](docs/deepseek.md)。

远程服务只接受 HTTPS。无需密钥的本机开发服务可以使用 `http://127.0.0.1:端口/v1`。浏览器预览需要服务允许跨域，本机服务还可能需要浏览器的本地网络许可；原生客户端通过 Rust 请求，不依赖浏览器 CORS。

Windows 原生客户端使用 Windows 凭据管理器，Android 使用由 Android Keystore 保护的应用凭据存储。启动时仅查询密钥是否存在；密钥不回传到界面、不写入书籍数据库、日志或默认备份，原生模型请求直接从系统安全存储读取。设置中留空会保留已保存密钥，也可以明确删除。浏览器预览仍只在本次运行内存中保留密钥。真实模型服务验收尚未执行；自动化测试使用本机协议测试服务。

首次在一台设备保存密钥后，后续启动不需要重新填写。安全凭据按设备保存，不随备份恢复，也不会同步到其他设备；请在每台设备分别配置。

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

阅读引擎固定到 foliate-js 提交 `78914aef4466eb960965702401634c2cb348e9b1`，包含四组可复现补丁，见 [VENDOR.md](src/vendor/foliate/VENDOR.md)。数学依赖统一使用已修复旧版本问题的 KaTeX，锁文件避免嵌套依赖退回旧版。

## 尚未完成

- Android 连续选区、旋转、键盘、面板与长时间阅读仍待验收。alpha.8 arm64 APK 已在 Android 16 / API 36 真机启动，并完成系统密钥保存、重启保留和删除验证；配置为 minSdk 31 / targetSdk 37，WebView 最低版本仍需实测确定。详见 [验证记录](docs/validation.md)。
- 两个真实模型服务验收，以及 AstrBot v4.27.4 内置 Agent、Connector、MCP / rmcp 的双向接入；Hermes / ACP 后续适配。
- 外部调用身份、MCP 配对与授权，以及外部会话打开 / 重连。内置问答已经通过 [统一任务与适配器入口](docs/task-runtime.md) 运行。
- SQLite FTS5、中文预分词、分段索引状态。当前受限文本扫描明确返回 `indexStatus: scan`，不伪装成已完成的全文索引。
- 数据库迁移 / 故障恢复长期验收、复杂 EPUB 样本与完整定位回退。
- PDF / OCR、图片公式识别、联网搜索、可执行插件和云同步。

EPUB 当前移除出版物 CSS、SVG 和主动内容，采用统一排版。复杂版式可能损失表现；标准文本与基础 MathML 路径仍需更多真实书籍样本验证。定位主要依赖清理后的 CFI，歧义文本不会自动跳转。参见 [开发计划](docs/roadmap.md)。

本轮实施清单见 [原生核心计划](docs/native-core-plan.md)。首个外部后端已选定为 **AstrBot v4.27.4 内置 Agent**，使用现有 Debian 源码部署实例，暂时固定版本；部署版本仍需现场核对。下一阶段先验证会话与停止接口，再完成外部调用身份、最小授权和双向书内工具；实际接入尚未完成。网络准备、固定版本依据和验收步骤见 [AstrBot 接入计划](docs/astrbot-integration.md)。

## 许可

自研代码采用 [Apache-2.0](LICENSE)，foliate-js 保留 MIT 许可，原创示例书采用 CC0 1.0。其他依赖遵守各自许可，见 `THIRD_PARTY_NOTICES.txt`。项目没有官方账号、强制订阅或遥测。
