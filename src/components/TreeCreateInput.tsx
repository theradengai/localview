import {
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

export type TreeCreateInputHandle = {
  focusAndSelect: () => void;
};

type TreeCreateInputProps = {
  ariaLabel: string;
  disabled: boolean;
  invalid?: boolean;
  maxLength: number;
  placeholder: string;
  onSubmit: (rawName: string) => void;
  onCancel: () => void;
};

const TreeCreateInput = memo(forwardRef<TreeCreateInputHandle, TreeCreateInputProps>(
  function TreeCreateInput({
    ariaLabel,
    disabled,
    invalid = false,
    maxLength,
    placeholder,
    onSubmit,
    onCancel,
  }, ref) {
    const [value, setValue] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);
    const composingRef = useRef(false);

    const focusAndSelect = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };

    useImperativeHandle(ref, () => ({ focusAndSelect }), []);
    useLayoutEffect(focusAndSelect, []);

    return <input
      ref={inputRef}
      className="tree-create-input"
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      value={value}
      disabled={disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      onChange={(event) => setValue(event.target.value)}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={() => { composingRef.current = false; }}
      onKeyDown={(event) => {
        if (composingRef.current || event.nativeEvent.isComposing) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          onSubmit(value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    />;
  },
));

export default TreeCreateInput;
