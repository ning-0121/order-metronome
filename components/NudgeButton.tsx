'use client';

import { useState } from 'react';

interface Props {
  milestoneId: string;
  milestoneName: string;
}

export function NudgeButton({ milestoneId, milestoneName }: Props) {
  const [status, setStatus] = useState<'idle' | 'input' | 'sending' | 'sent' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleSend() {
    setStatus('sending');

    try {
      const res = await fetch('/api/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ milestoneId, message: message.trim() || undefined }),
      });
      const json = await res.json();

      if (json.error) {
        if (json.error.includes('已在1小时内发送过')) {
          setStatus('sent');
        } else {
          alert(json.error);
          setStatus('idle');
        }
      } else {
        setStatus('sent');
        setMessage('');
      }
    } catch {
      alert('发送失败，请稍后重试');
      setStatus('idle');
    }
  }

  if (status === 'sent') {
    return (
      <span className="text-xs px-3 py-1.5 rounded-md bg-green-100 text-green-700 font-medium">
        已催办
      </span>
    );
  }

  if (status === 'input') {
    return (
      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={message}
          onChange={e => setMessage(e.target.value)}
          placeholder="附言（选填）"
          className="text-xs px-2 py-1 border border-orange-200 rounded-md w-36 focus:outline-none focus:border-orange-400"
          autoFocus
          onKeyDown={e => { if (e.key === 'Enter') handleSend(); }}
        />
        <button
          onClick={handleSend}
          disabled={status === 'sending'}
          className="text-xs px-2.5 py-1 rounded-md bg-orange-500 text-white hover:bg-orange-600 font-medium disabled:opacity-50"
        >
          {status === 'sending' ? '...' : '发送'}
        </button>
        <button
          onClick={() => { setStatus('idle'); setMessage(''); }}
          className="text-xs text-gray-400 hover:text-gray-600"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setStatus('input')}
      className="text-xs px-3 py-1.5 rounded-md border border-orange-300 text-orange-700 font-medium hover:bg-orange-50 active:bg-orange-100 transition-colors"
    >
      催一下
    </button>
  );
}
