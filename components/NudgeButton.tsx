'use client';

import { useState } from 'react';

interface Props {
  milestoneId: string;
  milestoneName: string;
}

export function NudgeButton({ milestoneId, milestoneName }: Props) {
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleNudge() {
    if (status === 'sent') return;
    setStatus('sending');

    try {
      const res = await fetch('/api/nudge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ milestoneId }),
      });
      const json = await res.json();

      if (json.error) {
        if (json.error.includes('已在1小时内发送过')) {
          setStatus('sent');
        } else {
          alert(json.error);
          setStatus('error');
          setTimeout(() => setStatus('idle'), 2000);
        }
      } else {
        setStatus('sent');
      }
    } catch {
      alert('发送失败，请稍后重试');
      setStatus('error');
      setTimeout(() => setStatus('idle'), 2000);
    }
  }

  if (status === 'sent') {
    return (
      <span className="text-xs px-3 py-1.5 rounded-md bg-green-100 text-green-700 font-medium">
        已催办
      </span>
    );
  }

  return (
    <button
      onClick={handleNudge}
      disabled={status === 'sending'}
      className="text-xs px-3 py-1.5 rounded-md border border-orange-300 text-orange-700 font-medium hover:bg-orange-50 active:bg-orange-100 transition-colors disabled:opacity-50"
    >
      {status === 'sending' ? '发送中...' : '催一下'}
    </button>
  );
}
