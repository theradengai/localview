import { useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TreeRenameInput, { type TreeRenameInputHandle } from './TreeRenameInput';

describe('TreeRenameInput', () => {
  it('selects the editable stem, renders a locked suffix, and submits once on Enter', async () => {
    const submit = vi.fn();
    const cancel = vi.fn();
    const user = userEvent.setup();
    render(<TreeRenameInput
      ariaLabel="重命名 notes.md，扩展名固定为 .md"
      disabled={false}
      initialValue="notes"
      lockedSuffix=".md"
      maxLength={252}
      onSubmit={submit}
      onCancel={cancel}
    />);
    const input = screen.getByRole('textbox', { name: /重命名 notes/ }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
    expect(screen.getByText('.md')).toBeTruthy();

    await user.clear(input);
    await user.type(input, '会议记录{Enter}');
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith('会议记录', 'enter');
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.blur(input);
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('does not submit during IME, cancels with Escape, and submits a changed value on blur', async () => {
    const submit = vi.fn();
    const cancel = vi.fn();
    const props = {
      ariaLabel: '重命名',
      disabled: false,
      initialValue: '初始',
      lockedSuffix: '',
      maxLength: 255,
      onSubmit: submit,
      onCancel: cancel,
    };
    const { rerender } = render(<TreeRenameInput {...props} />);
    let input = screen.getByRole('textbox', { name: '重命名' });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.blur(input);
    await Promise.resolve();
    expect(submit).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);

    rerender(<TreeRenameInput key="escape" {...props} />);
    input = screen.getByRole('textbox', { name: '重命名' });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(cancel).toHaveBeenCalledWith('escape');

    cancel.mockClear();
    rerender(<TreeRenameInput key="blur" {...props} />);
    input = screen.getByRole('textbox', { name: '重命名' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '完成' } });
    fireEvent.blur(input);
    await Promise.resolve();
    expect(submit).toHaveBeenCalledWith('完成', 'blur');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('silently cancels an unchanged trimmed value on blur and submits only once after Enter', async () => {
    const submit = vi.fn();
    const cancel = vi.fn();
    const { rerender } = render(<TreeRenameInput
      ariaLabel="重命名"
      disabled={false}
      initialValue="notes"
      lockedSuffix=".md"
      maxLength={252}
      onSubmit={submit}
      onCancel={cancel}
    />);
    let input = screen.getByRole('textbox', { name: '重命名' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: ' notes ' } });
    fireEvent.blur(input);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledWith('unchanged-blur');
    expect(submit).not.toHaveBeenCalled();

    cancel.mockClear();
    rerender(<TreeRenameInput
      key="enter-once"
      ariaLabel="重命名"
      disabled={false}
      initialValue="notes"
      lockedSuffix=".md"
      maxLength={252}
      onSubmit={submit}
      onCancel={cancel}
    />);
    input = screen.getByRole('textbox', { name: '重命名' }) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'journal' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    await Promise.resolve();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('journal', 'enter');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('keeps the local value through busy/invalid rerenders and supports imperative refocus', async () => {
    const submit = vi.fn();
    const cancel = vi.fn();
    function Host() {
      const [busy, setBusy] = useState(false);
      const [invalid, setInvalid] = useState(false);
      const ref = useRef<TreeRenameInputHandle>(null);
      return <>
        <button onClick={() => setBusy((value) => !value)}>busy</button>
        <button onClick={() => setInvalid((value) => !value)}>invalid</button>
        <button onClick={() => ref.current?.focusAndSelect()}>refocus</button>
        <TreeRenameInput
          ref={ref}
          ariaLabel="重命名"
          disabled={busy}
          initialValue="notes"
          invalid={invalid}
          lockedSuffix=".md"
          maxLength={252}
          onSubmit={submit}
          onCancel={cancel}
        />
      </>;
    }
    const user = userEvent.setup();
    render(<Host />);
    const input = screen.getByRole('textbox', { name: '重命名' }) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, 'draft');
    await user.click(screen.getByRole('button', { name: 'invalid' }));
    expect(input.value).toBe('draft');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'busy' }));
    expect(input.disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'busy' }));
    await user.click(screen.getByRole('button', { name: 'refocus' }));
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(5);
  });
});
