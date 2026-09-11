# LocalView

**打开文件，就看到文件夹上下文。**

一个轻量、macOS 优先的本地文档工作台：浏览真实目录，直接编辑 Markdown，预览 HTML 和表格，并排打开多个文件夹。

无需导入、无需 Vault、无需强制索引。文件仍然是你磁盘上的普通文件。

[English](README.md) · [下载 Beta](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.4) · [反馈问题](https://github.com/theradengai/localview/issues/new/choose) · [MIT 许可证](LICENSE)

![LocalView 预览、分栏、编辑、任务列表与 HTML 演示](docs/images/localview-demo.gif)

*动图使用虚构文档，演示预览、分栏、编辑、任务勾选和 HTML。真实文件读写由 macOS 应用提供。[查看静态截图](docs/images/localview-demo.png)。*

## 能做什么

- **从文件出发：** 在 Finder 里打开支持的文件，自动展示所在文件夹上下文，按需展开目录。
- **直接编辑 Markdown：** 默认预览；编辑时使用保留原始 Markdown 的实时预览，也可切换左预览、右源码的分栏。选中文字即可格式化，支持的表格可在单元格内编辑。
- **直接勾选任务：** 预览、分栏和编辑模式均可勾选，支持自动保存和撤销；兼容粘贴内容中的深缩进，保留原文空格和换行。
- **多格式预览：** HTML 本地交互预览、图片、PDF、CSV、Excel、ODS，以及 macOS Quick Look 提供的 Office/iWork 预览。
- **整理文件：** 新建 Markdown 和文件夹、双击重命名；用 `⌘` 多选或 `Shift` 连选文件与目录，整组拖动到其他文件夹，一次确认后批量移到废纸篓。详见[多选操作与安全边界](docs/FOLDER_SELECTION.md)。
- **自动保存：** 停止输入 600 ms 后写回原文件，`⌘S` 立即保存；检测外部修改，避免静默覆盖。
- **粘贴截图：** 在 Markdown 编辑或分栏模式按 `⌘V`，图片保存到文档旁的 `assets/`，自动插入相对引用。支持 PNG/JPEG/GIF/WebP，单次最多 8 张、合计 10 MB。
- **多窗口与打印：** `⌘N` 打开独立工作区窗口，`⌘P` 打印渲染后的 Markdown，并打开系统打印设置。

## 下载与安装

**0.2.0-beta.4 · macOS Monterey 12 及以上。** 本次为预发布测试版，不是稳定版。当前界面主要为简体中文；本次 Beta 不提供 Windows/Linux 支持。

| 电脑 | 安装包 |
| --- | --- |
| Apple Silicon，M 系列芯片 | [ARM64 DMG](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.4/LocalView_0.2.0-beta.4_aarch64.dmg) |
| Intel Mac，包括 Intel MacBook Air | [Intel DMG](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.4/LocalView_0.2.0-beta.4_x64.dmg) |

退出旧版 LocalView，打开 DMG，将应用拖入“应用程序”，弹出安装磁盘后，从“应用程序”打开。

目前是**临时签名、未经 Apple 公证的 Beta**，首次打开可能被系统拦截。安装前请看[安装与校验说明](docs/INSTALL.md)。Intel/Monterey 仍需要真实设备兼容性反馈；交叉编译成功不代表所有系统交互都已经实机验证。

## 格式与边界

| 格式 | 当前支持 |
| --- | --- |
| Markdown | 编辑、实时预览、分栏、可勾选任务的预览、渲染后打印 |
| HTML | 源码、分栏、隔离的本地交互预览 |
| 文本与常见代码文件 | 文本编辑、自动保存 |
| 图片、PDF | 预览 |
| CSV、XLS、XLSX、ODS | 只读表格、单元格换行、工作簿 Sheet 切换 |
| Numbers、Pages、Keynote、Word、PowerPoint | 系统 Quick Look 预览，翻页能力取决于已安装的系统预览组件 |

CSV 需要 UTF-8 编码（可带 BOM）、逗号分隔，前导零按文本保留。Office 编辑、公式重算、宏、图表和完整格式保真尚未实现。复杂 Markdown 表格可能回退源码编辑。打印目前只支持 Markdown。

完整说明见[功能与限制](docs/FEATURES.md)。

Markdown 预览和打印保留普通换行；切换编辑、分栏和预览时保留撤销记录；未编辑的表格单元格可显示粗体、斜体、删除线等格式。可用[格式测试样例](docs/fixtures/markdown-format-matrix.md)自行核对，验证范围见[测试记录](docs/MARKDOWN_FORMAT_VALIDATION.md)。

## 本地开发

需要 Node.js 24 LTS、Rust 1.91.1 或更高版本，以及 macOS 的 Xcode Command Line Tools。

```bash
git clone https://github.com/theradengai/localview.git
cd localview
npm ci
npm run tauri:dev
```

`npm run dev` 启动仅操作内存示例的浏览器演示；不会读写你的真实文件夹。

构建、测试与参与贡献请看 [CONTRIBUTING.md](CONTRIBUTING.md)。技术栈为 Tauri 2、React、TypeScript、CodeMirror 6 和 Rust。

## 反馈与许可

欢迎提交可复现的问题和小而明确的改进。请不要在公开 Issue 中上传私人文档或密钥；安全问题见 [SECURITY.md](SECURITY.md)。

LocalView 原创源码采用 [MIT 许可证](LICENSE)，第三方组件保留各自许可，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
