## LocalView 0.2.0-beta.6 — 中英文界面

**公开预发布测试版 / Public prerelease · macOS 12+**

### 下载与使用

M 系列 Mac 选择 `LocalView_0.2.0-beta.6_aarch64.dmg`，Intel Mac 选择 `LocalView_0.2.0-beta.6_x64.dmg`。正常退出旧版后用 DMG 替换应用。Beta 5 及之前的安装包不会自动获得此功能。

标题栏右上角可选择 **跟随系统 / 简体中文 / English**，立即生效并记住选择；其他已打开窗口同步更新，新窗口沿用设置。

### 本次更新

- LocalView 自有菜单、文件操作、状态与确认提示、Markdown 编辑工具、表格、看板和预览外层界面支持中英文。
- 原生 macOS 菜单同步切换，保留原有菜单标识、快捷键与行为。
- 修复原生多窗口快速切换语言时旧通知回退的问题，并补齐 About、Hide、Full Screen 的实际菜单文案。
- 切换不翻译或重写文件名、正文、工作表名、看板列名和卡片；保留编辑器实例、选区和撤销历史。新建模板使用创建时选择的语言。

### 验证与边界

514 项前端测试、生产构建、锁定依赖审计、macOS Rust 与临时废纸篓测试，以及 Chromium/WebKit 看板和双语检查通过。Apple Silicon 与 Intel 的原生 macOS 环境分别完成三窗口语言同步、快速切换、菜单还原、编辑器与原文保护验收；两套未注入测试代码的发布应用分别完成原生启动、架构、签名、许可证与磁盘镜像检查。具体源码提交、运行记录和校验值见附件。

仍为 **ad-hoc 签名、未公证的 Beta**，首次启动可能被 macOS 拦截。请按仓库安装说明处理，不需要关闭系统安全保护。Finder、文件选择器、打印设置及 Quick Look 等系统自有界面可跟随系统语言；原始错误详情保留原文。自动化验证不等于已完整覆盖 macOS 12 实机、实体设备输入法或所有系统对话框。

---

## English

Choose **System / 简体中文 / English** in the title bar. Switching is immediate and persistent, synchronizes existing desktop windows, and is inherited by new windows. LocalView-owned controls and native menu labels are localized without changing document content, editor identity, selection or undo history.

This release fixes stale notifications during rapid multiwindow language changes and completes the observed native About, Hide and Full Screen labels. New templates use the language selected at creation time; existing document text and names remain unchanged.

Both native architectures and the release source have automated validation evidence attached. These remain ad-hoc-signed, non-notarized prerelease builds. OS-owned dialogs and raw diagnostics retain their own language boundaries. Physical-device IME, macOS 12 hardware and every system interaction are not fully certified by automated smoke checks.
