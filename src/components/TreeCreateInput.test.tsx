import { useCallback, useRef, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import TreeCreateInput, { type TreeCreateInputHandle } from './TreeCreateInput';

describe('TreeCreateInput', () => {
  it('keeps typing local and only submits the complete value on Enter', async () => {
    const submit = vi.fn();
    const cancel = vi.fn();
    let hostRenders = 0;
    let siblingRenders = 0;

    function Sibling() {
      siblingRenders += 1;
      return <span>stable sibling</span>;
    }
    function Host() {
      hostRenders += 1;
      const onSubmit = useCallback((value: string) => submit(value), []);
      const onCancel = useCallback(() => cancel(), []);
      return <><Sibling /><TreeCreateInput ariaLabel="new entry" disabled={false} maxLength={255} placeholder="新建文件夹" onSubmit={onSubmit} onCancel={onCancel} /></>;
    }

    const user = userEvent.setup();
    render(<Host />);
    const input = screen.getByRole('textbox', { name: 'new entry' });
    expect(document.activeElement).toBe(input);
    const initialHostRenders = hostRenders;
    const initialSiblingRenders = siblingRenders;

    await user.type(input, '会议资料');
    expect(input).toHaveProperty('value', '会议资料');
    expect(hostRenders).toBe(initialHostRenders);
    expect(siblingRenders).toBe(initialSiblingRenders);
    expect(submit).not.toHaveBeenCalled();

    await user.keyboard('{Enter}');
    expect(submit).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledWith('会议资料');
  });

  it('handles IME, Escape, custom maxlength, focus, and prop rerenders without losing value', async () => {
    const submit = vi.fn();
    const cancel = vi.fn();

    function Host() {
      const [disabled, setDisabled] = useState(false);
      const [invalid, setInvalid] = useState(false);
      const [draftId, setDraftId] = useState(1);
      const inputRef = useRef<TreeCreateInputHandle>(null);
      return <>
        <button onClick={() => setDisabled((value) => !value)}>toggle disabled</button>
        <button onClick={() => setInvalid((value) => !value)}>toggle invalid</button>
        <button onClick={() => setDraftId((value) => value + 1)}>next draft</button>
        <button onClick={() => inputRef.current?.focusAndSelect()}>focus input</button>
        <TreeCreateInput
          key={draftId}
          ref={inputRef}
          ariaLabel="new entry"
          disabled={disabled}
          invalid={invalid}
          maxLength={120}
          placeholder="新建文件夹"
          onSubmit={submit}
          onCancel={cancel}
        />
      </>;
    }

    const user = userEvent.setup();
    render(<Host />);
    let input = screen.getByRole('textbox', { name: 'new entry' });
    expect(input.getAttribute('placeholder')).toBe('新建文件夹');
    await user.type(input, 'draft');
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(submit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);

    await user.click(screen.getByRole('button', { name: 'toggle invalid' }));
    expect(screen.getByRole('textbox', { name: 'new entry' })).toBe(input);
    expect(input).toHaveProperty('value', 'draft');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'toggle disabled' }));
    expect(input).toHaveProperty('disabled', true);
    await user.click(screen.getByRole('button', { name: 'toggle disabled' }));
    await user.click(screen.getByRole('button', { name: 'focus input' }));
    expect(document.activeElement).toBe(input);

    await user.keyboard('{Escape}');
    expect(cancel).toHaveBeenCalledOnce();
    expect(input.getAttribute('maxlength')).toBe('120');

    await user.click(screen.getByRole('button', { name: 'next draft' }));
    input = screen.getByRole('textbox', { name: 'new entry' });
    expect(input).toHaveProperty('value', '');
    expect(document.activeElement).toBe(input);
  });
});
