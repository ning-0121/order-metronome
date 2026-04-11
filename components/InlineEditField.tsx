'use client';

import { useState } from 'react';
import { updateOrderField } from '@/app/actions/orders';

interface Props {
  orderId: string;
  field: 'internal_order_no' | 'notes' | 'style_no';
  value: string | null;
  placeholder?: string;
  locked?: boolean;
  lockedMessage?: string;
}

export function InlineEditField({ orderId, field, value, placeholder = '点击填写', locked, lockedMessage }: Props) {
  const [editing, setEditing] = useState(false);
  const [inputValue, setInputValue] = useState(value || '');
  const [saving, setSaving] = useState(false);
  const [currentValue, setCurrentValue] = useState(value);

  async function handleSave() {
    if (inputValue === (currentValue || '')) {
      setEditing(false);
      return;
    }
    setSaving(true);
    const res = await updateOrderField(orderId, field, inputValue.trim());
    if (res.ok) {
      setCurrentValue(inputValue.trim() || null);
      setEditing(false);
    } else {
      alert(res.error || '保存失败');
    }
    setSaving(false);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') { setEditing(false); setInputValue(currentValue || ''); }
  }

  if (editing) {
    return (
      <input
        autoFocus
        type="text"
        value={inputValue}
        onChange={e => setInputValue(e.target.value)}
        onBlur={handleSave}
        onKeyDown={handleKeyDown}
        disabled={saving}
        placeholder={placeholder}
        className="w-full px-1.5 py-0.5 text-xs font-mono border border-indigo-300 rounded focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
      />
    );
  }

  return (
    <button
      onClick={() => {
        if (locked && currentValue) {
          alert(lockedMessage || '此字段已锁定');
          return;
        }
        setInputValue(currentValue || '');
        setEditing(true);
      }}
      className={`text-xs font-mono px-1.5 py-0.5 rounded transition-colors ${
        currentValue
          ? 'text-gray-600 hover:bg-gray-100'
          : 'text-indigo-500 hover:bg-indigo-50 border border-dashed border-indigo-300'
      }`}
      title={currentValue ? (locked ? '已锁定，修改需财务审批' : '点击编辑') : '点击填写'}
    >
      {currentValue || placeholder}
    </button>
  );
}
