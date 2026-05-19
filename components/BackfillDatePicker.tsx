'use client';

/**
 * 「补登实际完成时间」选择器
 *
 * 业务背景：采购在外面没法立刻上传单据，生产在车间忘了点系统，
 * 经常出现「实际昨天就完成了，今天才登录系统」的场景。如果只用
 * now() 作为 actual_at，会把这些「按时完成」误判成逾期。
 *
 * 行为：
 *   - 默认空 = 用「现在」作为 actual_at（绿色卡片，无补登）
 *   - 选择「今天/昨天/前天」= 用那天的 18:00 作为 actual_at
 *   - 自选日期 = 输入框，约束在 due_at 前后 6 个月内（防乱填）
 *
 * 服务端 markMilestoneDone 会再校验一次（不能未来、不能 > 6 月前），
 * 并把「补登」状态写到 milestone_logs.action='mark_done_backfill'。
 */

interface Props {
  value: string;
  onChange: (v: string) => void;
  dueAt?: string | null;
}

function ymd(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function BackfillDatePicker({ value, onChange, dueAt }: Props) {
  const today = new Date();
  const todayStr = ymd(today);
  const yesterdayStr = ymd(new Date(today.getTime() - 86400000));
  const dayBeforeStr = ymd(new Date(today.getTime() - 2 * 86400000));

  const presets: { label: string; value: string }[] = [
    { label: '现在', value: '' },
    { label: '今天', value: todayStr },
    { label: '昨天', value: yesterdayStr },
    { label: '前天', value: dayBeforeStr },
  ];

  // 判断当前选定日期是否「迟到补登」
  let hint = '';
  if (value) {
    const picked = new Date(`${value}T18:00:00`).getTime();
    if (dueAt) {
      const daysLate = Math.floor((picked - new Date(dueAt).getTime()) / 86400000);
      if (daysLate > 3) hint = `晚于截止 ${daysLate} 天，仍算逾期（含补登标记）`;
      else if (daysLate > 0) hint = `晚于截止 ${daysLate} 天，在 3 天宽限内不计逾期`;
      else hint = '在截止前完成 ✓';
    }
    const lag = Math.floor((Date.now() - picked) / 86400000);
    if (lag >= 1) hint = `${lag} 天前完成 — ${hint}`;
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-medium text-amber-900">🕒 实际完成时间</span>
        <span className="text-xs text-amber-700">外勤/车间没及时操作？补登实际时间</span>
      </div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {presets.map(p => (
          <button
            key={p.label}
            type="button"
            onClick={() => onChange(p.value)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium border transition-colors ${
              value === p.value
                ? 'bg-amber-600 text-white border-amber-600'
                : 'bg-white text-amber-800 border-amber-300 hover:bg-amber-100'
            }`}
          >
            {p.label}
          </button>
        ))}
        <input
          type="date"
          value={value && !presets.find(p => p.value === value) ? value : ''}
          max={todayStr}
          onChange={e => onChange(e.target.value)}
          className="px-2 py-1 rounded-md text-xs border border-amber-300 bg-white text-amber-900"
          placeholder="自选日期"
        />
      </div>
      {hint && (
        <p className="text-xs text-amber-700">{hint}</p>
      )}
    </div>
  );
}
