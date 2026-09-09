# Install and verify LocalView Beta

[English README](../README.md) · [中文说明](../README.zh-CN.md)

## Choose your installer

Open **Apple menu → About This Mac**. Choose `aarch64` for an Apple M-series chip, or `x64` for an Intel processor. The Beta targets **macOS Monterey 12 or later**.

Download from the [official release page](https://github.com/theradengai/localview/releases/tag/v0.2.0-beta.1). Quit the existing LocalView normally so pending edits can save. Open the DMG and drag LocalView into Applications, replacing an older copy if present. Eject the disk image, then launch `/Applications/LocalView.app`.

Launching multiple build copies or leaving installation disks mounted can produce duplicate application search/Open With results. Keep one installed copy in Applications; an Intel installer is for your Intel Mac, not a second app installation on Apple Silicon.

## Signing and first launch

This release is a **test build with an ad-hoc signature**, not a Developer ID signature or Apple notarization. macOS may block it because the developer cannot be verified.

If you trust the source and download, follow [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/en-us/102445). The exact labels differ by macOS version. Do not disable Gatekeeper globally. If your device is organization-managed, use its administrator's installation policy. Building from reviewed source is another option.

## Verify a download

The release includes `SHA256SUMS.txt`. In the download directory, calculate the SHA-256 of the installer you downloaded and compare it with that file:

```bash
shasum -a 256 LocalView_0.2.0-beta.1_aarch64.dmg
# Intel:
shasum -a 256 LocalView_0.2.0-beta.1_x64.dmg
```

Checksums protect against a mismatched/corrupted download; they are not publisher authentication. macOS can also check the disk-image structure and installed signature:

```bash
hdiutil verify LocalView_0.2.0-beta.1_aarch64.dmg
codesign --verify --deep --strict /Applications/LocalView.app
```

## First use

Open a folder in the app or use **Finder → Open With → LocalView** on a supported file. LocalView does not change your default application. `⌘N` opens another workspace window, `⌘S` saves immediately, and `⌘P` prints rendered Markdown.

Files are edited in place with auto-save. Try a sample folder first. If another application changes a dirty file, resolve the conflict before closing or switching files.

## 中文安装摘要

1. 在“关于本机”查看芯片：M 系列下载 `aarch64`，Intel 下载 `x64`。需要 macOS 12 或以上。
2. 正常退出旧版，打开 DMG，把 LocalView 拖入“应用程序”，再弹出安装磁盘。
3. 本次为未经 Apple 公证的 Beta。若首次打开被拦截，请按上面的 Apple 官方说明处理，不要全局关闭系统安全检查。
4. 从“应用程序”打开 LocalView，先用示例文件夹测试。文件会自动保存回原位置。
5. 问题反馈请注明版本、macOS、芯片类型和复现步骤；上传内容前移除私人资料。
