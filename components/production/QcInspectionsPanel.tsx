'use client';

/**
 * QC 检验台账 + 加查委派(2026-07-30)。
 *
 * 挂在 /production/order/[id] —— QC 被指引来的就是这个页面,而他自己的检验台账
 * (QcTab)此前只挂在 /orders/[id],那个页面又写着"生产/QC 请去生产中心",等于够不着。
 *
 * 两个写入方,列的所有权切干净(与 lib/domain/checklist.ts 已确立的规则一致):
 *   · 生产主管:委派(类型 / 派给谁 / 期限 / 说明)—— 不填结论
 *   · QC:回填结论(抽检数 / 合格 / 不合格 / 判定 / 备注)—— 不改委派
 * 中查/尾查走里程碑节点,不在这里派;这里派的是加查/上线审查/复检/巡查。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getQcInspections, assignQcInspection, completeQcInspection,
  cancelQcInspection, listQcCandidates,
} from '@/app/actions/qc';
import {
  QC_ASSIGNABLE_TYPES, QC_TASK_STATUS, QC_RESULT_LABELS, qcTypeLabel,
} from '@/lib/domain/qcInspection';

interface Props {
  orderId: string;
  /** 生产主管/admin:能委派 */
  canAssign: boolean;
  /** 生产/QC/主管/admin:能回填结论 */
  canReport: boolean;
  currentUserId?: string | null;
}

export function QcInspectionsPanel({ orderId, canAssign, canReport, currentUserId }: Props) {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 委派表单
  const [showAssign, setShowAssign] = useState(false);
  const [cands, setCands] = useState<Array<{ user_id: string; name: string }>>([]);
  const [aType, setAType] = useState<string>('extra');
  const [aWho, setAWho] = useState('');
  const [aDue, setADue] = useState('');
  const [aNote, setANote] = useState('');

  // 结论表单(按行展开)
  const [fillId, setFillId] = useState<string | null>(null);
  const [fQty, setFQty] = useState(''); const [fPass, setFPass] = useState('');
  const [fFail, setFFail] = useState(''); const [fResult, setFResult] = useState<'pass' | 'fail' | 'conditional'>('pass');
  const [fNotes, setFNotes] = useState('');

  const load = useCallback(async () => {
    const res = await getQcInspections(orderId);
    setLoading(false);
    if ((res as any).error) { setMsg({ kind: 'err', text: (res as any).error }); return; }
    setRows(((res as any).data || []) as any[]);
  }, [orderId]);

  useEffect(() => { void load(); }, [load]);

  async function openAssign() {
    setShowAssign(true); setMsg(null);
    if (cands.length === 0) {
      const res = await listQcCandidates();
      if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
      setCands(res.data || []);
      if ((res.data || []).length === 0) setMsg({ kind: 'err', text: '系统里还没有 QC 角色的同事,请先在用户管理里给人分配 QC 角色。' });
    }
  }

  async function doAssign() {
    if (!aWho) { setMsg({ kind: 'err', text: '请选择要委派的 QC' }); return; }
    setBusy('assign'); setMsg(null);
    const res = await assignQcInspection({ orderId, assignedTo: aWho, inspectionType: aType, dueDate: aDue || null, note: aNote || null });
    setBusy('');
    if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
    setShowAssign(false); setAWho(''); setADue(''); setANote(''); setAType('extra');
    setMsg({ kind: 'ok', text: '已委派,已站内通知该 QC。' });
    void load();
  }

  function openFill(r: any) {
    setFillId(r.id);
    setFQty(r.qty_inspected ? String(r.qty_inspected) : '');
    setFPass(r.qty_pass ? String(r.qty_pass) : '');
    setFFail(r.qty_fail ? String(r.qty_fail) : '');
    setFResult((r.result && r.result !== 'pending' ? r.result : 'pass') as any);
    setFNotes(r.notes || '');
    setMsg(null);
  }

  async function doComplete(r: any) {
    setBusy('fill:' + r.id); setMsg(null);
    const res = await completeQcInspection({
      id: r.id, orderId,
      qtyInspected: Number(fQty) || 0, qtyPass: Number(fPass) || 0, qtyFail: Number(fFail) || 0,
      result: fResult, notes: fNotes || null,
    });
    setBusy('');
    if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
    setFillId(null);
    setMsg({ kind: 'ok', text: '已记录检验结论。' });
    void load();
  }

  async function doCancel(r: any) {
    if (!window.confirm(`取消这条「${qcTypeLabel(r.inspection_type)}」委派?`)) return;
    setBusy('cancel:' + r.id);
    const res = await cancelQcInspection(r.id, orderId);
    setBusy('');
    if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
    void load();
  }

  const pending = rows.filter((r) => ['assigned', 'in_progress'].includes(String(r.task_status)));

  return (
    <div className="mt-6 bg-white rounded-xl border border-gray-200 p-5 md:p-6">
      <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
        <h2 className="text-lg font-semibold text-gray-900">🔍 QC 检验台账</h2>
        {canAssign && (
          <button onClick={() => (showAssign ? setShowAssign(false) : openAssign())} disabled={busy !== ''}
            className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">
            {showAssign ? '收起' : '+ 委派加查'}
          </button>
        )}
      </div>
      <p className="text-xs text-gray-500 mb-3">
        上线审查 / 加查 / 复检在此登记;中查、尾查走上面的生产节点。
        {pending.length > 0 && <span className="ml-1 text-amber-700 font-medium">当前有 {pending.length} 项待检验。</span>}
      </p>

      {msg && (
        <p className={`text-xs mb-3 ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-rose-600'}`}>{msg.text}</p>
      )}

      {showAssign && canAssign && (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-3 mb-4 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
            <label className="text-xs text-gray-600">
              <span className="block mb-1">检验类型</span>
              <select value={aType} onChange={(e) => setAType(e.target.value)}
                className="w-full text-xs border rounded-lg px-2 py-1.5 bg-white">
                {QC_ASSIGNABLE_TYPES.map((t) => <option key={t} value={t}>{qcTypeLabel(t)}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-600">
              <span className="block mb-1">派给哪位 QC</span>
              <select value={aWho} onChange={(e) => setAWho(e.target.value)}
                className="w-full text-xs border rounded-lg px-2 py-1.5 bg-white">
                <option value="">请选择…</option>
                {cands.map((c) => <option key={c.user_id} value={c.user_id}>{c.name}</option>)}
              </select>
            </label>
            <label className="text-xs text-gray-600">
              <span className="block mb-1">要求完成日(可选)</span>
              <input type="date" value={aDue} onChange={(e) => setADue(e.target.value)}
                className="w-full text-xs border rounded-lg px-2 py-1.5 bg-white" />
            </label>
            <label className="text-xs text-gray-600 sm:col-span-1">
              <span className="block mb-1">说明(可选)</span>
              <input value={aNote} onChange={(e) => setANote(e.target.value)} placeholder="查什么/为什么加查"
                className="w-full text-xs border rounded-lg px-2 py-1.5 bg-white" />
            </label>
          </div>
          <div className="flex justify-end">
            <button onClick={doAssign} disabled={busy !== ''}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-700 font-medium disabled:opacity-50">
              {busy === 'assign' ? '委派中…' : '确认委派'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-xs text-gray-400 py-6 text-center">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-gray-400 py-6 text-center">还没有检验记录。{canAssign ? '可点右上角「委派加查」。' : ''}</p>
      ) : (
        <ul className="divide-y divide-gray-100 border border-gray-200 rounded-lg">
          {rows.map((r) => {
            const st = QC_TASK_STATUS[String(r.task_status)] || QC_TASK_STATUS.done;
            const rs = QC_RESULT_LABELS[String(r.result)] || QC_RESULT_LABELS.pending;
            const mine = !!currentUserId && r.assigned_to === currentUserId;
            const open = fillId === r.id;
            return (
              <li key={r.id} className="px-3 py-2.5">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-900">{qcTypeLabel(r.inspection_type)}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded border ${st.cls}`}>{st.label}</span>
                      {mine && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">派给我的</span>}
                      {String(r.task_status) === 'done' && (
                        <span className={`text-[11px] font-medium ${rs.cls}`}>{rs.label}</span>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-500 mt-0.5">
                      {r.due_date ? `要求 ${String(r.due_date).slice(0, 10)} 前 · ` : ''}
                      {String(r.task_status) === 'done'
                        ? `抽检 ${r.qty_inspected} · 合格 ${r.qty_pass} · 不合格 ${r.qty_fail} · ${String(r.inspection_date || '').slice(0, 10)}`
                        : '待 QC 回填结论'}
                    </p>
                    {r.assignment_note && <p className="text-[11px] text-gray-500 mt-0.5">说明:{r.assignment_note}</p>}
                    {r.notes && <p className="text-[11px] text-gray-600 mt-0.5">结论备注:{r.notes}</p>}
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    {canReport && String(r.task_status) !== 'cancelled' && (
                      <button onClick={() => (open ? setFillId(null) : openFill(r))} disabled={busy !== ''}
                        className="text-[11px] px-2 py-1 rounded border border-indigo-200 text-indigo-600 hover:bg-indigo-50 disabled:opacity-50">
                        {open ? '收起' : String(r.task_status) === 'done' ? '修改结论' : '填结论'}
                      </button>
                    )}
                    {canAssign && ['assigned', 'in_progress'].includes(String(r.task_status)) && (
                      <button onClick={() => doCancel(r)} disabled={busy !== ''}
                        className="text-[11px] px-2 py-1 rounded border border-gray-200 text-gray-500 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
                        取消
                      </button>
                    )}
                  </div>
                </div>

                {open && (
                  <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2.5 grid grid-cols-2 sm:grid-cols-5 gap-2 items-end">
                    <label className="text-[11px] text-gray-600">
                      <span className="block mb-1">抽检数</span>
                      <input type="number" min="0" value={fQty} onChange={(e) => setFQty(e.target.value)}
                        className="w-full text-xs border rounded px-2 py-1 bg-white" />
                    </label>
                    <label className="text-[11px] text-gray-600">
                      <span className="block mb-1">合格</span>
                      <input type="number" min="0" value={fPass} onChange={(e) => setFPass(e.target.value)}
                        className="w-full text-xs border rounded px-2 py-1 bg-white" />
                    </label>
                    <label className="text-[11px] text-gray-600">
                      <span className="block mb-1">不合格</span>
                      <input type="number" min="0" value={fFail} onChange={(e) => setFFail(e.target.value)}
                        className="w-full text-xs border rounded px-2 py-1 bg-white" />
                    </label>
                    <label className="text-[11px] text-gray-600">
                      <span className="block mb-1">判定</span>
                      <select value={fResult} onChange={(e) => setFResult(e.target.value as any)}
                        className="w-full text-xs border rounded px-2 py-1 bg-white">
                        <option value="pass">合格</option>
                        <option value="fail">不合格</option>
                        <option value="conditional">有条件放行</option>
                      </select>
                    </label>
                    <button onClick={() => doComplete(r)} disabled={busy !== ''}
                      className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 font-medium disabled:opacity-50">
                      {busy === 'fill:' + r.id ? '保存中…' : '保存结论'}
                    </button>
                    <label className="text-[11px] text-gray-600 col-span-2 sm:col-span-5">
                      <span className="block mb-1">备注(问题描述/整改要求)</span>
                      <input value={fNotes} onChange={(e) => setFNotes(e.target.value)}
                        className="w-full text-xs border rounded px-2 py-1 bg-white" />
                    </label>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
