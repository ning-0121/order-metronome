'use client';

// 订单进度校准(2026-07-09 用户):真实订单之前没人在系统推进 → 早期节点全逾期 → 业务端"风险"。
// admin/生产主管 选"实际到了哪个节点" → 之前标完成(风险消失)、该节点进行中。仅 admin/生产主管 可见。
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { calibrateOrderStage, rebuildOrderMilestones } from '@/app/actions/order-progress-calibrate';

export function OrderProgressCalibrate({ orderId, steps }: {
  orderId: string;
  steps: Array<{ step_key: string; name: string }>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stepKey, setStepKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [msg, setMsg] = useState('');

  async function rebuild() {
    if (!confirm('把本单里程碑重建为「最新节点模板」?\n\n只适用于「刚建、还没开始推进」的单。已经在跑的单不要用这个 —— 下一步会告诉你具体会丢什么。')) return;
    setRebuilding(true); setMsg('');
    // 先不带 force 探一次:后端有进度就会拦下来并带回具体损失数字,
    // 让人看着真实数量决定,而不是对着一句笼统的"会重置进度"点确定。
    let r: any = await rebuildOrderMilestones(orderId);
    if (r?.needsConfirm) {
      const l = r.loss || {};
      const ok = confirm(
        `⚠️ 本单已经在推进中,重建会永久清空:\n\n`
        + `  · ${l.done || 0} 个已完成节点(含完成时间)\n`
        + `  · ${l.checklists || 0} 份验货/检查记录\n`
        + `  · ${l.notes || 0} 条节点备注\n\n`
        + `共 ${l.total || 0} 个节点全部推倒重来,不可恢复,「进度校准」也只能把状态设回去、找不回验货记录。\n\n`
        + `确定继续吗?`,
      );
      if (!ok) { setRebuilding(false); setMsg('已取消,未做任何改动。'); return; }
      r = await rebuildOrderMilestones(orderId, { force: true });
    }
    setRebuilding(false);
    if (r?.error) { setMsg('❌ ' + r.error); return; }
    setMsg(`✅ 已重建为最新模板(${r?.count} 个节点)。如需设当前进度请用「进度校准」。`);
    router.refresh();
  }

  async function apply() {
    if (!stepKey) return;
    if (!confirm('把所选节点之前的里程碑全部标为「已完成」、该节点设「进行中」?之前阶段的逾期风险会一并消失。')) return;
    setSaving(true); setMsg('');
    const r = await calibrateOrderStage(orderId, stepKey);
    setSaving(false);
    if ((r as any).error) { setMsg('❌ ' + (r as any).error); return; }
    setMsg(`✅ 已校准(标完成 ${(r as any).done} 个之前节点),风险已刷新`);
    router.refresh();
  }

  if (!steps.length) return null;
  if (!open) {
    return (
      <div className="flex items-center gap-2 flex-wrap justify-end">
        <button onClick={() => setOpen(true)}
          className="text-xs px-2.5 py-1 rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 font-medium"
          title="真实订单之前没人在系统推进导致一片风险 → 选实际到了哪个节点,之前的标完成、清风险">
          🎯 进度校准（清历史风险）
        </button>
        <button onClick={rebuild} disabled={rebuilding}
          className="text-xs px-2.5 py-1 rounded-lg border border-indigo-300 text-indigo-700 hover:bg-indigo-50 font-medium disabled:opacity-50"
          title="部署前建的单节点还是老版(9节点)→ 重建为最新 14 节点模板(会重置进度,可再校准)">
          {rebuilding ? '重建中…' : '🔧 重建为最新节点模板'}
        </button>
        <Link href="/orders/progress-calibrate" className="text-[11px] text-indigo-600 hover:underline">批量校准多单 →</Link>
        {msg && <span className="text-xs text-gray-600">{msg}</span>}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <select value={stepKey} onChange={(e) => setStepKey(e.target.value)}
        className="text-sm border border-gray-300 rounded-lg px-2 py-1 bg-white">
        <option value="">实际到了哪个节点…</option>
        {steps.map((s) => <option key={s.step_key} value={s.step_key}>{s.name}</option>)}
      </select>
      <button onClick={apply} disabled={saving || !stepKey}
        className="text-xs px-2.5 py-1 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50">
        {saving ? '校准中…' : '之前标完成·清风险'}
      </button>
      <button onClick={() => { setOpen(false); setMsg(''); }} className="text-xs text-gray-400 hover:text-gray-600">取消</button>
      {msg && <span className="text-xs text-gray-600">{msg}</span>}
    </div>
  );
}
