'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  updateCustomerScheduleOverrides,
  type CustomerWithOverrides,
} from '@/app/actions/customer-schedules';
import {
  ANCHOR_LABEL,
  OVERRIDABLE_STEPS,
  type ScheduleAnchor,
  type ScheduleOverrideRule,
} from '@/lib/constants/schedule-anchors';

interface Props {
  initialRows: CustomerWithOverrides[];
  initialError?: string;
}

export function CustomerSchedulesClient({ initialRows, initialError }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<CustomerWithOverrides | null>(null);
  const [overrides, setOverrides] = useState<Record<string, ScheduleOverrideRule>>({});
  const [pending, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(r =>
      r.customer_name.toLowerCase().includes(q) ||
      (r.customer_code || '').toLowerCase().includes(q)
    );
  }, [rows, search]);

  const openEditor = (row: CustomerWithOverrides) => {
    setSelected(row);
    setOverrides(row.schedule_overrides as Record<string, ScheduleOverrideRule>);
    setMsg(null);
  };

  const closeEditor = () => {
    setSelected(null);
    setOverrides({});
    setMsg(null);
  };

  const toggleStep = (stepKey: string) => {
    setOverrides(prev => {
      if (prev[stepKey]) {
        const { [stepKey]: _, ...rest } = prev;
        return rest;
      }
      return {
        ...prev,
        [stepKey]: { anchor: 'factory_date', offset_days: -1 },
      };
    });
  };

  const updateField = (stepKey: string, patch: Partial<ScheduleOverrideRule>) => {
    setOverrides(prev => ({
      ...prev,
      [stepKey]: { ...prev[stepKey], ...patch },
    }));
  };

  const save = () => {
    if (!selected) return;
    startTransition(async () => {
      const result = await updateCustomerScheduleOverrides(selected.id, overrides);
      if (result.error) {
        setMsg({ type: 'err', text: result.error });
      } else {
        setMsg({ type: 'ok', text: '保存成功' });
        // 更新本地列表
        setRows(prev => prev.map(r =>
          r.id === selected.id
            ? { ...r, schedule_overrides: overrides, overrides_count: Object.keys(overrides).length }
            : r
        ));
        setTimeout(() => {
          closeEditor();
          router.refresh();
        }, 800);
      }
    });
  };

  if (initialError) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{initialError}</div>
    );
  }

  const configuredCount = rows.filter(r => r.overrides_count > 0).length;

  return (
    <div className="space-y-6">
      {/* 汇总 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard label="客户总数" value={rows.length} tone="gray" />
        <SummaryCard label="已配置自定义节奏" value={configuredCount} tone="cyan" />
        <SummaryCard
          label="总规则数"
          value={rows.reduce((s, r) => s + r.overrides_count, 0)}
          tone="blue"
        />
      </div>

      {/* 搜索 */}
      <div className="flex items-center gap-3 rounded-lg border border-gray-200 bg-white p-4">
        <input
          type="text"
          className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm"
          placeholder="🔍 搜索客户名 / 代码..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="text-sm text-gray-500">{filtered.length} / {rows.length}</div>
      </div>

      {/* 客户列表 */}
      <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              <Th>客户</Th>
              <Th>代码</Th>
              <Th>国家</Th>
              <Th>自定义规则</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {filtered.map(row => (
              <tr key={row.id} className="hover:bg-gray-50">
                <td className="px-3 py-3 font-medium text-gray-900">{row.customer_name}</td>
                <td className="px-3 py-3 font-mono text-xs text-gray-600">{row.customer_code || '—'}</td>
                <td className="px-3 py-3 text-gray-600">{row.country || '—'}</td>
                <td className="px-3 py-3">
                  {row.overrides_count > 0 ? (
                    <span className="inline-flex items-center rounded-full bg-cyan-100 px-2 py-0.5 text-xs font-medium text-cyan-800">
                      ⚡ {row.overrides_count} 条规则
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400">使用通用节奏</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <button
                    onClick={() => openEditor(row)}
                    className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100"
                  >
                    {row.overrides_count > 0 ? '✏️ 编辑节奏' : '➕ 配置节奏'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 编辑弹层 */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeEditor}>
          <div className="w-full max-w-3xl max-h-[90vh] overflow-hidden rounded-xl bg-white shadow-2xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="border-b border-gray-100 px-6 py-4">
              <div className="text-lg font-bold text-gray-900">配置节奏偏好 — {selected.customer_name}</div>
              <div className="mt-1 text-sm text-gray-500">
                勾选需要自定义的关卡，设置锚点和偏移天数。未勾选的关卡沿用通用模板。
              </div>
            </div>

            <div className="flex-1 overflow-auto px-6 py-4">
              <div className="mb-4 rounded-md bg-blue-50 p-3 text-xs text-blue-900">
                💡 示例：RAG 要求<b>离厂前 1 天</b>寄船样 → 勾选"船样寄送"，锚点选"离厂日"，偏移填 <code>-1</code>
              </div>

              {/* 按阶段分组 */}
              {Array.from(new Set(OVERRIDABLE_STEPS.map(s => s.stage))).map(stage => (
                <div key={stage} className="mb-4">
                  <div className="mb-2 text-sm font-semibold text-gray-700">{stage}</div>
                  <div className="space-y-2">
                    {OVERRIDABLE_STEPS.filter(s => s.stage === stage).map(step => {
                      const rule = overrides[step.step_key];
                      const enabled = !!rule;
                      return (
                        <div
                          key={step.step_key}
                          className={`rounded-md border p-3 ${enabled ? 'border-cyan-300 bg-cyan-50/30' : 'border-gray-200 bg-white'}`}
                        >
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={enabled}
                              onChange={() => toggleStep(step.step_key)}
                            />
                            <span className="font-medium text-gray-900">{step.name}</span>
                            <code className="text-[10px] text-gray-400">{step.step_key}</code>
                          </label>

                          {enabled && (
                            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                              <div>
                                <label className="mb-1 block text-xs text-gray-600">锚点</label>
                                <select
                                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                                  value={rule.anchor}
                                  onChange={(e) => updateField(step.step_key, { anchor: e.target.value as ScheduleAnchor })}
                                >
                                  {(Object.keys(ANCHOR_LABEL) as ScheduleAnchor[]).map(a => (
                                    <option key={a} value={a}>{ANCHOR_LABEL[a]}</option>
                                  ))}
                                </select>
                              </div>
                              <div>
                                <label className="mb-1 block text-xs text-gray-600">偏移天数（负=之前 / 正=之后）</label>
                                <input
                                  type="number"
                                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                                  value={rule.offset_days}
                                  onChange={(e) => updateField(step.step_key, { offset_days: Number(e.target.value) })}
                                  min={-120} max={120}
                                />
                              </div>
                              <div>
                                <label className="mb-1 block text-xs text-gray-600">备注（可选）</label>
                                <input
                                  type="text"
                                  className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm"
                                  placeholder="例：RAG 习惯"
                                  value={rule.note || ''}
                                  onChange={(e) => updateField(step.step_key, { note: e.target.value })}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>

            {msg && (
              <div className={`px-6 py-2 text-sm ${
                msg.type === 'ok' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
              }`}>
                {msg.text}
              </div>
            )}

            <div className="flex justify-between gap-2 border-t border-gray-100 bg-gray-50 px-6 py-3">
              <div className="text-sm text-gray-500 self-center">
                已配置 <b className="text-gray-900">{Object.keys(overrides).length}</b> 条规则
              </div>
              <div className="flex gap-2">
                <button
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50"
                  onClick={closeEditor}
                  disabled={pending}
                >
                  取消
                </button>
                <button
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  onClick={save}
                  disabled={pending}
                >
                  {pending ? '保存中…' : '保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-600">{children}</th>;
}

function SummaryCard({ label, value, tone }: { label: string; value: number; tone: 'gray' | 'cyan' | 'blue' }) {
  const tones = {
    gray: 'from-gray-500 to-gray-600',
    cyan: 'from-cyan-500 to-cyan-600',
    blue: 'from-blue-500 to-blue-600',
  };
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className={`mt-2 bg-gradient-to-br ${tones[tone]} bg-clip-text text-3xl font-bold text-transparent`}>
        {value}
      </div>
    </div>
  );
}
