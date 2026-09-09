import {
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export type TreeRenameInputHandle = {
  focusAndSelect: () => void;
};

export type RenameSubmitReason = 'enter' | 'blur';
export type RenameCancelReason = 'escape' | 'unchanged-blur';

type Props = {
  ariaLabel: string;
  disabled: boolean;
  initialValue: string;
  invalid?: boolean;
  lockedSuffix: string;
  maxLength: number;
  onSubmit: (rawEditableName: string, reason: RenameSubmitReason) => void;
  onCancel: (reason: RenameCancelReason) => void;
};

const TreeRenameInput = memo(forwardRef<TreeRenameInputHandle, Props>(
  function TreeRenameInput({
    ariaLabel,
    disabled,
    initialValue,
    invalid = false,
    lockedSuffix,
    maxLength,
    onSubmit,
    onCancel,
  }, ref) {
    const [value, setValue] = useState(initialValue);
    const inputRef = useRef<HTMLInputElement>(null);
    const composingRef = useRef(false);
    const submittedRef = useRef(false);

    const focusAndSelect = () => {
      submittedRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    useImperativeHandle(ref, () => ({ focusAndSelect }), []);
    useLayoutEffect(focusAndSelect, []);

    const finishBlur = () => {
      if (composingRef.current || submittedRef.current || disabled) return;
      submittedRef.current = true;
      if (value.trim() === initialValue) onCancel('unchanged-blur');
      else onSubmit(value, 'blur');
    };

    return <div className="tree-rename-input-shell">
      <input
        ref={inputRef}
        className="tree-rename-input"
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        value={value}
        disabled={disabled}
        maxLength={maxLength}
        style={lockedSuffix ? { paddingRight: `${lockedSuffix.length + 1}ch` } : undefined}
        onChange={(event) => setValue(event.target.value)}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => {
          composingRef.current = false;
          if (document.activeElement !== inputRef.current) queueMicrotask(finishBlur);
        }}
        onKeyDown={(event) => {
          if (composingRef.current || event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') {
            event.preventDefault();
            submittedRef.current = true;
            onSubmit(value, 'enter');
          } else if (event.key === 'Escape') {
            event.preventDefault();
            submittedRef.current = true;
            onCancel('escape');
          }
        }}
        onBlur={finishBlur}
      />
      {lockedSuffix ? <span className="tree-rename-suffix" aria-hidden="true">{lockedSuffix}</span> : null}
    </div>;
  },
));

export default TreeRenameInput;
