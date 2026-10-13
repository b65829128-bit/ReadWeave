# ReadWeave 工程约定

- 产品设计依据是 `docs/product-plan-v0.3.zh-CN.md`，当前实际范围见 README、roadmap 和 validation。原始方案保持历史原貌。
- 正式平台只承诺 Windows 11 和 Android。浏览器预览用于开发；没有其他平台发布矩阵。
- 不把兼容模型 API、模拟服务、接口声明当成已完成的外部 Harness。真实模型与设备验收要记录证据。
- 阅读内容、AI Markdown、插件包和备份都视为不可信。不得关闭安全清理或恢复 EPUB 脚本来绕过兼容问题。
- 凭据只留在内存，直到跨平台安全存储经过验证；不可持久化明文密钥或写入日志。
- 模型不可通过参数修改书籍、版本或授权边界。外部 MCP 开放前先迁移原生权限服务。
- 阅读引擎只通过 ReaderAdapter 接入。修改 vendored JS 时同步更新复现脚本和 VENDOR.md，不单独格式化上游源码。
- npm 依赖精确固定，提交 package-lock.json 和 Cargo.lock。代码使用 TypeScript 严格模式，遵循 Prettier 与 cargo fmt。
- 根据改动运行 `npm run check`、相关浏览器测试和原生测试，保持验证记录准确。不要为纯样式改动添加镜像实现的测试。
- 使用本地 Git 分阶段提交。未经要求，不创建远程仓库、不推送、不上传真实书籍、密钥或用户数据。
