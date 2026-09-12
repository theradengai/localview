# Kanban screenshots / 看板截图来源

These are actual production-frontend screenshots, not a generated UI or the standalone prototype. 截图来自实际生产前端，不是生成式效果图或独立原型。

- Application source: [LocalView Beta 5, 3ebf48f](https://github.com/theradengai/localview/commit/3ebf48f9f917bc1296ea65cd9e5bb78cd8990255). Capture-only helpers do not change application code.
- Input: [the existing synthetic Markdown fixture](../fixtures/kanban.md). All cards and the displayed demo paths are fictional; browser edits stay in memory. No native bridge, user desktop, private documents or external page resources are accessed.
- Engine: WebKit 26.0 via isolated Playwright 1.58.2; viewport 1440 × 920 at 1×.
- [Capture and source/interaction checks](https://github.com/theradengai/localview/actions/runs/34692156939).
- Views: [board](localview-kanban-board.png), [card details](localview-kanban-details.png), [Split](localview-kanban-split.png). Images are unretouched viewport captures; no native macOS installation, filesystem or compatibility acceptance is implied.
- The existing general-purpose LocalView demo GIF is retained unchanged.

## Capture recipe

Build the pinned source with its locked dependencies. In the in-memory browser demo, create 发布计划.md through the folder's New board menu, paste the fixture through the source editor, and wait for the save indicator and transient notice to settle. Capture Preview; open 支持 Markdown 看板 #产品 for details; close the drawer and switch to Split. Source equality, card counts, subtask states, a real pointer move and undo are checked in the capture run.

## Asset integrity

| File | Bytes | SHA256 |
| --- | ---: | --- |
| localview-kanban-board.png | 144758 | `06b5e4b60965061cef367b6f97a4cbbac52b694577d106842bb4cb315a8e4c9b` |
| localview-kanban-details.png | 173906 | `5d6774d8b87801b81ef6d41ad8a6d6b95dc873a0f7fd79bd13a9f6a902f1e8c8` |
| localview-kanban-split.png | 211699 | `601da514c8fe32e8afe4410969140c23e993d930c910d7c39335246da04c01e1` |

Fixture SHA256: `1b0e4b33a1687e6b0bcf7d3699e93daa992e395e7f7287f28a8808582f3aef47`.
