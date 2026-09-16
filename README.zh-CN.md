# LocalView

**无需索引，直接打开。多格式预览与编辑。**

一个面向 **macOS 和 Windows** 的轻量本地文档工作台：直接打开文件或文件夹，浏览真实目录，预览不同格式，在原处编辑 Markdown、HTML 和文本。

**不需要索引，也不需要导入。** 文件留在原文件夹，仍然是磁盘上的普通文件。

[English](README.md) · [Windows Beta](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.7) · [macOS Beta](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.6) · [反馈问题](https://github.com/theradengai/localview/issues/new/choose) · [MIT 许可证](LICENSE)

![LocalView 预览、分栏、编辑、任务列表与 HTML 演示](docs/images/localview-demo.gif)

*动图使用虚构文档，演示预览、分栏、编辑、任务勾选和 HTML。真实文件读写由桌面应用提供。[查看静态截图](docs/images/localview-demo.png)。*

## 能做什么

- **Markdown 可操作看板：** 在文件夹 `+` 菜单选择“新建看板”，拖动卡片和列，单击卡片在右侧编辑详情；分栏查看同一份 `.md` 源码，共享撤销和自动保存。[格式与边界](docs/KANBAN.md)。
- **从文件出发：** 点击“打开文件”或“打开文件夹”，直接展示所在目录上下文，按需展开；Windows 支持 `Ctrl+O` 打开文件，macOS 保留 Finder 集成。
- **直接编辑 Markdown：** 默认预览；编辑时使用保留原始 Markdown 的实时预览，也可切换左预览、右源码的分栏。选中文字即可格式化，支持的表格可在单元格内编辑。
- **直接勾选任务：** 预览、分栏和编辑模式均可勾选，支持自动保存和撤销；兼容粘贴内容中的深缩进，保留原文空格和换行。
- **多格式预览：** HTML 本地交互预览、图片、PDF、CSV、Excel、ODS；Office/iWork 在 macOS 使用 Quick Look，Windows 提供“用默认应用打开”，不冒充内嵌 Office 预览。
- **整理文件：** 新建 Markdown 和文件夹、双击重命名；用 `⌘` / `Ctrl` 多选或 `Shift` 连选文件与目录，整组拖动到其他文件夹，一次确认后批量移到 macOS 废纸篓或 Windows 回收站。详见[多选操作与安全边界](docs/FOLDER_SELECTION.md)。
- **自动保存：** 停止输入 600 ms 后写回原文件，`⌘S` / `Ctrl+S` 立即保存；检测外部修改，避免静默覆盖。
- **粘贴截图：** 在 Markdown 编辑或分栏模式按 `⌘V` / `Ctrl+V`，图片保存到文档旁的 `assets/`，自动插入相对引用。支持 PNG/JPEG/GIF/WebP，单次最多 8 张、合计 10 MB。
- **多窗口与打印：** `⌘N` / `Ctrl+N` 打开独立工作区窗口，`⌘P` / `Ctrl+P` 打印渲染后的 Markdown，并打开系统打印设置。

## 界面语言

两个桌面平台都可在标题栏选择 **跟随系统 / 简体中文 / English**（macOS 自 Beta 6 起提供）。切换立即生效并记住选择，不翻译已有文件、不重建编辑器。[行为边界与验证说明](docs/LANGUAGES.md)。

## Markdown 看板

在文件夹 `+` 菜单选择 **新建看板**，或打开[示例 Markdown 文件](docs/fixtures/kanban.md)。文件开头的 `localview: kanban` 标记启用看板：`##` 二级标题是列，顶层任务项是卡片，缩进的说明和子任务随卡片一起移动。普通任务清单仍使用原来的预览。

![LocalView 看板预览：四列卡片、标签和子任务进度](docs/images/localview-kanban-board.png)

*截图来自 Beta 5 实际生产前端，在隔离的 WebKit 浏览器中使用仓库内的虚构示例；不是 macOS 原生安装包的验收截图，浏览器中的编辑仅保存在内存。*

[右侧卡片详情](docs/images/localview-kanban-details.png) · [看板／Markdown 分栏](docs/images/localview-kanban-split.png) · [截图来源](docs/images/KANBAN_CAPTURES.md) · [完整说明与限制](docs/KANBAN.md)

拖动卡片把手整理位置，也可在详情中选择目标列。**预览**显示看板，**编辑**显示 Markdown 源码，**分栏**同时显示两者。移动到某一列不会自动勾选完成。文件树支持多选，但本版看板卡片不支持多选。打印仍使用 Markdown 阅读视图，不是看板图片。

## 下载与安装

**Windows x64：0.2.0-beta.7；macOS：0.2.0-beta.6。** 都是预发布测试版，不是稳定版，均支持中英文界面。Windows 首版面向 Windows 10/11 x64、WebView2 与本地盘符目录；不包含 Windows 原生 ARM64、UNC/网络目录或 Linux 安装包。详见 [Windows 使用与验证边界](docs/WINDOWS.md)。

**[下载 Windows x64 安装包](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.7/LocalView_0.2.0-beta.7_x64-setup.exe)** · [Windows 校验文件](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.7/SHA256SUMS.txt)

运行 EXE 后安装到当前用户。若缺少 WebView2，安装程序会联网下载其引导程序。本 Beta **尚未进行 Windows 代码签名**，可能出现未知发布者/SmartScreen 提示；请核对来源和校验值，不需要关闭系统安全保护。

已有 macOS Beta 6 安装包保持不变，要求 macOS Monterey 12 及以上：

| 电脑 | 安装包 |
| --- | --- |
| Apple Silicon，M 系列芯片 | [ARM64 DMG](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.6/LocalView_0.2.0-beta.6_aarch64.dmg) |
| Intel Mac，包括 Intel MacBook Air | [Intel DMG](https://github.com/theradengai/localview/releases/download/v0.2.0-beta.6/LocalView_0.2.0-beta.6_x64.dmg) |

退出旧版 LocalView，打开 DMG，将应用拖入“应用程序”，弹出安装磁盘后，从“应用程序”打开。

目前是**临时签名、未经 Apple 公证的 Beta**，首次打开可能被系统拦截。安装前请看[安装与校验说明](docs/INSTALL.md)。Intel/Monterey 仍需要真实设备兼容性反馈；交叉编译成功不代表所有系统交互都已经实机验证。

## 格式与边界

| 格式 | 当前支持 |
| --- | --- |
| Markdown | 编辑、实时预览、分栏、可勾选任务的预览、渲染后打印 |
| Markdown 看板（`localview: kanban`） | 可操作看板、卡片详情与子任务、卡片／列排序；与源码共享撤销和自动保存 |
| HTML | 源码、分栏、隔离的本地交互预览 |
| 文本与常见代码文件 | 文本编辑、自动保存 |
| 图片、PDF | 预览 |
| CSV、XLS、XLSX、ODS | 只读表格、单元格换行、工作簿 Sheet 切换 |
| Numbers、Pages、Keynote、Word、PowerPoint | macOS：系统 Quick Look，翻页取决于预览组件；Windows：用默认应用打开，不支持内嵌 Office/iWork 预览 |

CSV 需要 UTF-8 编码（可带 BOM）、逗号分隔，前导零按文本保留。Office 编辑、公式重算、宏、图表和完整格式保真尚未实现。复杂 Markdown 表格可能回退源码编辑。打印目前只支持 Markdown。

完整说明见[功能与限制](docs/FEATURES.md)。

Markdown 预览和打印保留普通换行；切换编辑、分栏和预览时保留撤销记录；未编辑的表格单元格可显示粗体、斜体、删除线等格式。可用[格式测试样例](docs/fixtures/markdown-format-matrix.md)自行核对，验证范围见[测试记录](docs/MARKDOWN_FORMAT_VALIDATION.md)。

## 本地开发

需要 Node.js 24 LTS、Rust 1.91.1 或更高版本。macOS 需要 Xcode Command Line Tools；Windows 需要 MSVC Rust 工具链、C++ Build Tools/Windows SDK 与 Microsoft WebView2，详见 [Windows 开发说明](docs/WINDOWS.md#development)。

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
