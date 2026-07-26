import {
  forwardRef,
  memo,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { MAX_MARKDOWN_FILENAME_UTF16_UNITS } from '../lib/markdownFilename';

export type MarkdownCreateInputHandle = {
  focusAndSelect: () => void;
};

type MarkdownCreateInputProps = {
  ariaLabel: string;
  disabled: boolean;
  invalid?: boolean;
  onSubmit: (rawName: string) => void;
  onCancel: () => void;
};

const MarkdownCreateInput = memo(forwardRef<MarkdownCreateInputHandle, MarkdownCreateInputProps>(
  function MarkdownCreateInput({ ariaLabel, disabled, invalid = false, onSubmit, onCancel }, ref) {
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
      maxLength={MAX_MARKDOWN_FILENAME_UTF16_UNITS}
      placeholder="untitled.md"
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

export default MarkdownCreateInput;
