from pathlib import Path
import json
import subprocess
import sys


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError('Expected exactly one reviewed source fragment: ' + old[:90])
    return text.replace(old, new, 1)


def verify_blob(path, expected):
    actual = subprocess.check_output(['git', 'hash-object', path], text=True).strip()
    if actual != expected:
        raise RuntimeError('Source changed since review: ' + path)


TESTS = r'''
  it('captures Trash identities after atomic save for an included dirty file', async () => {
    await readyFolders();
    const pendingSave = deferred<string>();
    let identity = 'before-save';
    mocks.writeTextFile.mockImplementation(async () => {
      const version = await pendingSave.promise;
      identity = 'after-save';
      return version;
    });
    const prepare = mocks.prepareTrash.getMockImplementation()!;
    mocks.prepareTrash.mockImplementation(async (value: string) => ({
      ...await prepare(value), targetIdentity: value === path('plan.md') ? identity : 'folder',
    }));
    const perform = mocks.moveToTrash.getMockImplementation()!;
    mocks.moveToTrash.mockImplementation(async (candidate: { originalPath: string; targetIdentity: string }) => {
      if (candidate.originalPath === path('plan.md') && candidate.targetIdentity !== identity) {
        throw new Error('TRASH_TARGET_CHANGED');
      }
      return perform(candidate);
    });
    await editCurrentDocument('# dirty synthetic file');
    select('alpha', 'plan.md');
    menu('alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: '移到废纸篓' }));
    await waitFor(() => expect(mocks.writeTextFile).toHaveBeenCalledOnce());
    expect(mocks.prepareTrash).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => pendingSave.resolve('v2'));
    await screen.findByRole('alertdialog');
    expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(row('plan.md')).toBeNull());
    expect(row('alpha')).toBeNull();
    expect(mocks.moveToTrash).toHaveBeenCalledTimes(2);
    expect(mocks.moveToTrash.mock.calls[1][0].targetIdentity).toBe('after-save');
  });

  it('saves before single-item Trash preflight and cancellation preserves the file', async () => {
    await readyFolders();
    const calls: string[] = [];
    mocks.writeTextFile.mockImplementation(async () => { calls.push('save'); return 'v2'; });
    const prepare = mocks.prepareTrash.getMockImplementation()!;
    mocks.prepareTrash.mockImplementation(async (value: string) => { calls.push('prepare'); return prepare(value); });
    await editCurrentDocument('# single dirty file');
    select('plan.md');
    await trash('plan.md');
    expect(calls).toEqual(['save', 'prepare']);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mocks.moveToTrash).not.toHaveBeenCalled();
    expect(row('plan.md')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'editor' })).toHaveProperty('disabled', false));
  });

  it('never refreshes a Trash identity after confirmation when the selected file was replaced', async () => {
    await readyFolders();
    let identity = 'original';
    const prepare = mocks.prepareTrash.getMockImplementation()!;
    mocks.prepareTrash.mockImplementation(async (value: string) => ({ ...await prepare(value), targetIdentity: identity }));
    mocks.moveToTrash.mockImplementation(async (candidate: { targetIdentity: string }) => {
      if (candidate.targetIdentity !== identity) throw new Error('TRASH_TARGET_CHANGED');
      throw new Error('Unexpected mutation');
    });
    select('alpha', 'beta');
    await trash('alpha');
    identity = 'external-replacement';
    fireEvent.click(screen.getByRole('button', { name: '移到废纸篓' }));
    await waitFor(() => expect(mocks.moveToTrash).toHaveBeenCalledOnce());
    await screen.findByText(/0\/2 项/);
    expect(mocks.prepareTrash).toHaveBeenCalledTimes(2);
    expect(row('alpha')).toBeTruthy();
    expect(row('beta')).toBeTruthy();
    expect(pressed()).toEqual([path('alpha'), path('beta')]);
  });

  it('retains every preflighted move identity when a later source is replaced', async () => {
    await readyFolders();
    let betaIdentity = 'original-beta';
    const prepare = mocks.prepareWorkspaceMove.getMockImplementation()!;
    mocks.prepareWorkspaceMove.mockImplementation(async (source: string, destination: string) => ({
      ...await prepare(source, destination), sourceIdentity: source === path('beta') ? betaIdentity : 'original-alpha',
    }));
    const perform = mocks.moveWorkspaceEntry.getMockImplementation()!;
    mocks.moveWorkspaceEntry.mockImplementation(async (candidate: { sourcePath: string; sourceIdentity: string }) => {
      if (candidate.sourcePath === path('alpha')) {
        const result = await perform(candidate);
        betaIdentity = 'replacement-beta';
        return result;
      }
      if (candidate.sourceIdentity !== betaIdentity) throw new Error('MOVE_SOURCE_CHANGED');
      return perform(candidate);
    });
    select('alpha', 'beta');
    await move('alpha');
    await waitFor(() => expect(mocks.moveWorkspaceEntry).toHaveBeenCalledTimes(2));
    await screen.findByText(/已确认移动 1\/2 项/);
    expect(mocks.prepareWorkspaceMove).toHaveBeenCalledTimes(2);
    expect(mocks.moveWorkspaceEntry.mock.calls[1][0].sourceIdentity).toBe('original-beta');
    expect(row('beta')).toBeTruthy();
    expect(row('target/beta')).toBeNull();
    expect(pressed()).toEqual([path('beta')]);
  });

'''

TRASH = r'''  const requestTrashSelection = useCallback(async (input: FileNode | FileNode[]) => {
    const nodes = operationRoots(input);
    if (!nodes.length) return;
    if (trashBatchPendingRef.current) return void showNotice('请先处理当前废纸篓操作');
    setTreeActionMenu(null);
    cancelRename(false);
    if (workspaceTransitionRef.current || documentActionGateRef.current !== 'idle'
      || createBusyRef.current !== null || createDraftRef.current || renameDraftRef.current) {
      showNotice('请先完成当前操作');
      return;
    }
    const root = normalizePath(rootPathRef.current);
    if (!root || nodes.some((node) => normalizePath(node.path) === root || !containsPath(root, node.path))) {
      showNotice('不能操作工作区根目录或工作区之外的项目');
      return;
    }
    const epoch = workspaceEpochRef.current;
    const generation = workspaceBindingRef.current?.generation;
    const current = () => !unmountedRef.current && workspaceEpochRef.current === epoch
      && workspaceBindingRef.current?.generation === generation && normalizePath(rootPathRef.current) === root
      && !workspaceTransitionRef.current;
    const multiple = nodes.length > 1;
    let completedCount = 0;
    trashBatchPendingRef.current = true;
    // The save guard must finish before capturing inode identities. Keep its gate
    // through preflight, confirmation and commit; never refresh consented identities.
    const prepareAndTrash = () => runWorkspaceMutation(async () => {
      const candidates = new Map<string, Awaited<ReturnType<typeof prepareTrash>>>();
      for (const node of nodes) {
        if (!current() || !findNode(treeRef.current, node.path)) {
          showNotice('工作区或所选项目已经变化，已取消废纸篓操作');
          return;
        }
        if (desktop) candidates.set(normalizePath(node.path), await prepareTrash(node.path));
      }
      if (!current()) return;
      const names = nodes.slice(0, 5).map((node) => `“${node.name}”`).join('、');
      const node = nodes[0];
      const decision = await requestDecision({
        title: multiple ? `将 ${nodes.length} 项移到废纸篓？` : '移到废纸篓？',
        message: multiple
          ? `${names}${nodes.length > 5 ? '等' : ''}将移到 macOS 废纸篓；文件夹及其内容会一起移动，可以从废纸篓恢复。逐项执行，失败时停止，已完成的项目不会自动撤销。`
          : node.kind === 'folder'
            ? `“${node.name}”及其中的内容会一起移到 macOS 废纸篓。`
            : `“${node.name}”会移到 macOS 废纸篓，可以从废纸篓恢复。`,
        confirmLabel: '移到废纸篓', cancelLabel: '取消', destructive: true,
      });
      if (decision !== 'confirm') return;
      if (!current()) return void showNotice('工作区已经变化，已取消废纸篓操作');
      const result = await runTreeBatch(nodes, async (entry): Promise<TreeOperationResult> => {
        if (!current()) return { ok: false, message: '工作区已经变化' };
        const path = normalizePath(entry.path);
        const parent = parentPath(path);
        directoryRefreshCoordinatorRef.current?.invalidate(parent);
        try {
          if (desktop) await moveToTrash(candidates.get(path)!);
          if (!current()) return { ok: false, message: '磁盘操作已提交，但工作区已经变化，请确认实际结果' };
          const next = removeTreePath(treeRef.current, path) as FileNode[];
          const expanded = new Set([...openFoldersRef.current].filter((item) => !containsPath(path, item)));
          treeRef.current = next;
          setTree(next);
          openFoldersRef.current = expanded;
          setOpenFolders(expanded);
          const committed = committedWorkspaceSnapshotRef.current;
          if (committed && normalizePath(committed.rootPath) === root) {
            committed.tree = removeTreePath(committed.tree, path) as FileNode[];
            committed.openFolders = new Set([...committed.openFolders].filter((item) => !containsPath(path, item)));
          }
          if (selectedRef.current && containsPath(path, selectedRef.current.path)) clearCurrentDocument();
          completedCount += 1;
          return { ok: true };
        } catch (error) {
          return { ok: false, message: trashError(error) };
        } finally {
          if (current()) directoryRefreshCoordinatorRef.current?.request([parent]);
        }
      });
      if (!current()) return;
      const remaining = result.remaining.map((entry) => normalizePath(entry.path));
      replaceTreeSelection(remaining);
      const focus = remaining[0] ?? parentPath(nodes[0].path);
      if (completedCount > 0) {
        if (focus !== root && findNode(treeRef.current, focus)) setPendingTreeFocusPath(focus);
        else window.setTimeout(() => sidebarFocusFallbackRef.current?.focus(), 0);
      }
      showNotice(result.failure
        ? multiple ? `已移到废纸篓 ${completedCount}/${nodes.length} 项；停在“${result.remaining[0].name}”：${result.failure}；未继续处理其余项目` : result.failure
        : multiple
          ? desktop ? `已将 ${nodes.length} 项移到废纸篓` : `浏览器 Demo 已模拟删除 ${nodes.length} 项；未移动磁盘文件`
          : desktop ? `已将 ${node.name} 移到废纸篓` : `浏览器 Demo 已模拟删除 ${node.name}；未移动磁盘文件`);
    });
    try {
      const selectedPath = selectedRef.current?.path;
      if (selectedPath && nodes.some((node) => containsPath(node.path, selectedPath))) {
        await runWithSaveGuard('deleting', '移到废纸篓', prepareAndTrash);
      } else {
        if (!flushActiveEditorSurface()) return void showNotice('表格单元格状态已经变化，无法删除其他文件');
        documentActionGateRef.current = 'deleting';
        setDocumentActionGate('deleting');
        try { await prepareAndTrash(); } finally {
          documentActionGateRef.current = 'idle';
          if (!unmountedRef.current) setDocumentActionGate('idle');
        }
      }
    } catch (error) {
      showNotice(multiple ? `批量废纸篓操作已停止：${trashError(error)}` : trashError(error));
    } finally {
      trashBatchPendingRef.current = false;
      if (!completedCount) window.setTimeout(() => {
        const trigger = lastContextTriggerRef.current;
        if (trigger?.isConnected) trigger.focus();
        else sidebarFocusFallbackRef.current?.focus();
      }, 0);
    }
  }, [cancelRename, clearCurrentDocument, desktop, flushActiveEditorSurface, operationRoots, replaceTreeSelection, requestDecision, runWithSaveGuard, runWorkspaceMutation, showNotice]);

'''

mode = sys.argv[1]
if mode == 'tests':
    verify_blob('src/App.test.tsx', '0734d553438077ef5d90aa08c789bab3dbf8326b')
    file = Path('src/App.test.tsx')
    file.write_text(replace_once(file.read_text(), "  it('keeps delete shortcuts inside the editor away from the tree selection',", TESTS + "  it('keeps delete shortcuts inside the editor away from the tree selection',"))
elif mode == 'fix':
    verify_blob('src/App.tsx', 'f4ba831d9347933c8c78aa3a98c1b97da0d30c9d')
    file = Path('src/App.tsx')
    text = file.read_text()
    start = text.index('  const requestTrash = useCallback(')
    end = text.index('  useEffect(() => {\n    if (!treeActionMenu) return;', start)
    text = text[:start] + TRASH + text[end:]
    text = replace_once(text,
        'const performWorkspaceMove = useCallback(async (node: FileNode, destinationPath: string): Promise<TreeOperationResult> => {',
        'const performWorkspaceMove = useCallback(async (node: FileNode, destinationPath: string, preparedCandidate?: MoveCandidate): Promise<TreeOperationResult> => {')
    text = replace_once(text,
        'const candidate: MoveCandidate = await prepareWorkspaceMove(sourcePath, destination);',
        'const candidate: MoveCandidate = preparedCandidate ?? await prepareWorkspaceMove(sourcePath, destination);')
    text = replace_once(text,
        '// Save a contained editor and validate every source before the first disk mutation.\n        for (const node of nodes)',
        '// Save and capture every identity before the first mutation; do not re-authorize replacements.\n        const candidates = new Map<string, MoveCandidate>();\n        for (const node of nodes)')
    text = replace_once(text,
        'const candidate = await prepareWorkspaceMove(node.path, destinationPath);\n            if (!current()',
        'const candidate = await prepareWorkspaceMove(node.path, destinationPath);\n            candidates.set(normalizePath(node.path), candidate);\n            if (!current()')
    text = replace_once(text,
        'return performWorkspaceMove(latest, destinationPath);',
        'return performWorkspaceMove(latest, destinationPath, candidates.get(normalizePath(node.path)));')
    file.write_text(text)
    # Keep all candidate package versions consistent, without creating a public tag/release.
    for filename in ['package.json', 'package-lock.json', 'src-tauri/tauri.conf.json']:
        file = Path(filename)
        text = file.read_text()
        if '0.2.0-beta.1' not in text:
            raise RuntimeError('Unexpected version in ' + filename)
        file.write_text(text.replace('0.2.0-beta.1', '0.2.0-beta.2'))
    for filename in ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']:
        file = Path(filename)
        file.write_text(replace_once(file.read_text(), 'version = "0.2.0-beta.1"', 'version = "0.2.0-beta.2"'))
    notes = Path('docs/FOLDER_SELECTION.md')
    notes.write_text(notes.read_text() + '\n\n## 0.2.0-beta.2 candidate review\n\nTrash now flushes an included editor before capturing target identities and holds its operation gate through confirmation. Single and batch Trash share this path. Batch moves retain all preflighted native candidates, so a later same-name replacement is rejected rather than re-authorized. Added four identity/save-order regression tests.\n\nThis is a candidate build, not a public release. The existing public Beta 1 download links remain unchanged until desktop acceptance and staging promotion. Candidate installers carry their source SHA and SHA256 checksums. Automated checks do not replace real macOS UI acceptance.\n')
    changelog = Path('CHANGELOG.md')
    text = changelog.read_text()
    header, rest = text.split('\n', 1)
    changelog.write_text(header + '\n\n## 0.2.0-beta.2 — candidate (not released)\n\n- Directory/file multi-selection and batch move/Trash.\n- Save-before-preflight Trash ordering and retained move identities.\n- Candidate installers only; pending desktop acceptance and staging promotion.\n' + rest)
else:
    raise RuntimeError('Unknown mode')
