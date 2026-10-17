# ReadWeave 阅读桥接 0.1.1

仅支持 **AstrBot 4.27.4 / 内置 Agent / Python 3.12+**。本次服务器环境为 Debian、uv 安装，WebUI 在本机 6185 端口。此插件不修改模型配置，不需要增加 API Key 的 `plugin` 或管理员权限。

## 安装

1. 在 AstrBot 网页打开「插件市场 / 插件管理」，使用「安装插件 → 本地上传」选择 `astrbot_plugin_readweave-0.1.1.zip`。若当前界面没有上传入口，将 ZIP 中的 `astrbot_plugin_readweave` 文件夹放入**当前 AstrBot 数据目录**的 `plugins` 子目录，再在网页重载插件或重启 AstrBot。不要放到 uv 的包安装目录。
2. 确认插件列表出现 ReadWeave 且已启用。插件仅监听服务器 `127.0.0.1:6186`；不需要在防火墙或云安全组开放 6186。
3. 保留原有网页隧道，在本机新开终端运行：

   ```powershell
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:16186:127.0.0.1:6186 用户名@服务器IP
   ```

   将用户名和服务器 IP 换成现有 SSH 连接使用的值，保持终端运行。也可在原隧道命令中增加这条 `-L`，同时转发两个端口。

4. 在 ReadWeave Windows 客户端「设置 → 模型连接 → 阅读伙伴」选择「AstrBot v4.27.4 · 内置 Agent」。桥接地址填 `http://127.0.0.1:16186`，输入专用、仅有 `chat` 权限的 API Key。
5. 用项目示例书发送问题，确认资料预览，再检查回答、工具执行、引用跳转和停止。alpha.12 的真实 Bot、工具与原文引用已有用户确认；alpha.13 的停止后追问行为需要更新两端后单独复测。

已在聊天中发送过的旧密钥请撤销；新密钥只在客户端密码框输入，不要贴回聊天。AstrBot 密钥只留在 ReadWeave 本次运行内存。没有 WebUI 登录密码或管理员权限的 API Key 不能安装插件，因此安装应在你已登录的网页中操作。

## 数据和边界

- 插件为每个 ReadWeave 话题新建由该 API Key 拥有的 AstrBot 会话；不会接管现有会话。正常追问复用会话；换书、改范围或退出话题时关闭并删除这条专用会话。网络或密钥失效时可能需要在 AstrBot 手动清理残留会话。
- 配合 ReadWeave alpha.13，「停止回答」保留本地对话与引用；下一问使用原来冻结的阅读位置和范围，重新建立原生读取授权与专用 AstrBot 会话。最近 12 条可见消息（JSON 最多 32,000 字符）及所引用原文（最多 16,000 字符）作为继续追问的上下文，不重放旧工具调用或思考过程。旧执行与旧停止操作不会指向新会话。
- 阅读资料和问题会经过服务器及其配置的模型。AstrBot 会按自身机制保存聊天，其他已启用插件也可能接触事件。首次联调使用示例书，不发送真实私人书籍。
- 模型只有 `readweave_book_search` 和 `readweave_book_read_passage` 两个受限工具，插件转成标准 MCP `book_search` / `book_read_passage`。权限绑定取自 AstrBot 事件的会话及运行编号；书籍、范围、预算、有效期与引用由 ReadWeave Rust 核心决定。
- 此协议通过认证的专用 HTTP 轮询承载标准 MCP JSON-RPC；它不是可供任意 MCP 客户端连接的 Streamable HTTP 服务。
- 停止先撤销本机读取权限，再调用 AstrBot 的会话停止接口，并读取会话状态确认没有活动执行；仅收到停止应答不算成功。停止中的旧话题拒绝再次启动，队列中与执行中的书内工具结果会重新核对授权。即使远程停止或删除失败，关闭仍释放桥接名额；无法确认停止时客户端提示检查服务器。断线超过 45 秒会拒绝工具并释放桥接；断开 SSE 本身不能证明上游模型或其他插件已停止。没有保留原始密钥的后台清理不再调用远程停止。
- 空闲话题 10 分钟后释放；原生授权还有自己的期限和预算。此版本的 Android / 公网 HTTPS 未验收，本机 SSH 地址不能直接用于 Android。

插件复用 AstrBot 安装的 `mcp`、`anyio`、`fastapi`、`uvicorn` 和 `httpx`，没有额外的插件 requirements 安装步骤。若 AstrBot WebUI 端口不是 6185，需要在 `bridge.py` 修改固定本机上游地址后重新打包；不提供模型可更改的地址参数。

## 从 0.1.0 更新

先停止 ReadWeave 的回答并退出旧客户端。在 AstrBot 插件管理中停用 ReadWeave，用上述 ZIP 更新同一个 `astrbot_plugin_readweave` 目录，再重载并启用；列表应显示 `0.1.1`。没有覆盖上传入口时，可在停用后解压覆盖该目录中的同名文件，再重载。无需升级 AstrBot、改变端口转发或扩大密钥权限。

启动 `ReadWeave-alpha.13.exe`，在设置中重新输入本次内存密钥。测试先提问，再让它展开；输出中点击「停止回答」，随后发送「请接着刚才的解释」。检查历史仍在、追问接得上、旧回答不再增长、旧引用仍可定位。更换书籍或范围后应另开话题。异常断线不会自动重新发送书籍资料。

## 源码与复现

源码位于 ReadWeave 的 `integrations/astrbot/`，Apache-2.0。运行 `node scripts/package-astrbot.mjs` 将规范工具定义和许可证一并打包到 `.local/astrbot/`。测试依赖仅用于独立本地环境，不要用 `requirements-test.txt` 覆盖服务器上的 AstrBot 依赖。
