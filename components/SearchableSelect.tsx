'use client';

/**
 * 可搜索下拉(原生 input + datalist,零依赖)。供应商等长列表用,输入即过滤。
 * value=选中项的 value;options.label 是显示/搜索文本,选中后按 label 反查 value。
 * allowFreeText:允许非选项的自由文本(如历史手敲的供应商名),此时 onChange 直接回传文本。
 */

import { useState, useEffect, useId } from 'react';

export function SearchableSelect({
  options, value, onChange, placeholder = '选择 / 搜索', className = '', allowFreeText = false,
}: {
  options: { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
  allowFreeText?: boolean;
}) {
  const listId = 'ss-' + useId().replace(/:/g, '');
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? (allowFreeText ? v : '');
  const [text, setText] = useState(labelOf(value));
  useEffect(() => { setText(labelOf(value)); /* 外部 value 变化时同步显示 */ // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, options.length]);

  return (
    <>
      <input
        list={listId}
        value={text}
        placeholder={placeholder}
        className={className}
        onChange={(e) => {
          const t = e.target.value;
          setText(t);
          const hit = options.find((o) => o.label === t);
          if (hit) onChange(hit.value);
          else onChange(allowFreeText ? t : '');
        }}
      />
      <datalist id={listId}>
        {options.map((o) => <option key={o.value} value={o.label} />)}
      </datalist>
    </>
  );
}
