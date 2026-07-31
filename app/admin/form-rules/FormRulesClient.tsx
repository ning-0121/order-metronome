'use client';

/**
 * 建单表单字段配置(2026-07-31,L2 第三步)。
 *
 * 让管理员自己决定「哪个字段显示 / 要不要必填 / 默认值是什么」,不用再找人改代码。
 * 代码默认在 lib/domain/formRules.ts;这里只存**差异**,删掉一条 = 该字段回到默认。
 *
 * 刻意做的两件事:
 *   · 每个字段都把「代码默认」显示出来,让人知道自己在改的是什么、改了之后差别在哪;
 *   · 「不覆盖」是一等选项(而不是逼人在 是/否 里二选一)—— 只想改必填的人不该被迫连显示也钉死。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  listFormFieldRules, upsertFormFieldRule, deleteFormFieldRule, listConfigurableFields,
  type FormFieldRuleRow,
} from '@/app/actions/form-field-rules';

type FieldMeta = { field: string; label: string; defaultVisible: boolean; defaultRequired: string };
type Customer = { id: string; customer_name: string };

/** 三态:null = 不覆盖 */
function TriToggle({ value, onChange, labels }: {
  value: boolean | null; onChange: (v: boolean | null) => void; labels: [string, string];
}) {
  const opts: Array<{ v: boolean | null; t: string }> = [
    { v: null, t: '不覆盖' }, { v: true, t: labels[0] }, { v: false, t: labels[1] },
  ];
  return (
    <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
      {opts.map((o) => (
        <button key={String(o.v)} type="button" onClick={() => onChange(o.v)}
          className={`px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.v ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}>
          {o.t}
        </button>
      ))}
    </div>
  );
}

export function FormRulesClient({ customers }: { customers: Customer[] }) {
  const [rows, setRows] = useState<FormFieldRuleRow[]>([]);
  const [fields, setFields] = useState<FieldMeta[]>([]);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);

  // 新增表单
  const [nField, setNField] = useState('');
  const [nScope, setNScope] = useState<'global' | 'customer'>('global');
  const [nCust, setNCust] = useState('');
  const [nVisible, setNVisible] = useState<boolean | null>(null);
  const [nRequired, setNRequired] = useState<boolean | null>(null);
  const [nDefault, setNDefault] = useState('');
  const [nNote, setNNote] = useState('');

  const load = useCallback(async () => {
    const [r, f] = await Promise.all([listFormFieldRules(), listConfigurableFields()]);
    setLoading(false);
    if (r.error) { setMsg({ kind: 'err', text: r.error }); return; }
    setRows(r.data || []);
    setFields(f.data || []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const metaOf = (f: string) => fields.find((x) => x.field === f);
  const custName = (id: string | null) => customers.find((c) => c.id === id)?.customer_name || id || '—';

  async function add() {
    if (!nField) { setMsg({ kind: 'err', text: '请选择要配置的字段' }); return; }
    setBusy('add'); setMsg(null);
    const res = await upsertFormFieldRule({
      fieldName: nField, scope: nScope, scopeId: nScope === 'customer' ? nCust : null,
      visible: nVisible, required: nRequired, defaultValue: nDefault || null, note: nNote || null,
    });
    setBusy('');
    if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
    setNField(''); setNVisible(null); setNRequired(null); setNDefault(''); setNNote('');
    setMsg({ kind: 'ok', text: '已保存。建单页刷新后生效。' });
    void load();
  }

  async function patch(row: FormFieldRuleRow, next: Partial<FormFieldRuleRow>) {
    setBusy(row.id); setMsg(null);
    const m = { ...row, ...next };
    const res = await upsertFormFieldRule({
      id: row.id, fieldName: m.field_name, scope: m.scope, scopeId: m.scope_id,
      visible: m.visible, required: m.required, defaultValue: m.default_value, note: m.note,
    });
    setBusy('');
    if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
    void load();
  }

  async function remove(row: FormFieldRuleRow) {
    const meta = metaOf(row.field_name);
    if (!window.confirm(`删除「${meta?.label || row.field_name}」的这条配置?\n删除后该字段回到代码默认(${meta?.defaultRequired || '默认'})。`)) return;
    setBusy(row.id);
    const res = await deleteFormFieldRule(row.id);
    setBusy('');
    if (res.error) { setMsg({ kind: 'err', text: res.error }); return; }
    void load();
  }

  const globals = rows.filter((r) => r.scope === 'global');
  const perCust = rows.filter((r) => r.scope === 'customer');

  const Table = ({ list, showCust }: { list: FormFieldRuleRow[]; showCust?: boolean }) => (
    <div className="overflow-x-auto rounded-xl border border-gray-200">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 text-gray-500 text-xs">
          <tr>
            <th className="text-left px-3 py-2.5">字段</th>
            {showCust && <th className="text-left px-3 py-2.5">客户</th>}
            <th className="text-left px-3 py-2.5">代码默认</th>
            <th className="text-left px-3 py-2.5">显示</th>
            <th className="text-left px-3 py-2.5">必填</th>
            <th className="text-left px-3 py-2.5">默认值</th>
            <th className="text-left px-3 py-2.5">备注</th>
            <th className="px-3 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => {
            const m = metaOf(r.field_name);
            return (
              <tr key={r.id} className="border-t border-gray-100">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-gray-900">{m?.label || r.field_name}</div>
                  <div className="text-[11px] text-gray-400 font-mono">{r.field_name}</div>
                </td>
                {showCust && <td className="px-3 py-2.5 text-gray-700">{custName(r.scope_id)}</td>}
                <td className="px-3 py-2.5 text-xs text-gray-500">{m?.defaultRequired || '—'}</td>
                <td className="px-3 py-2.5">
                  <TriToggle value={r.visible} labels={['显示', '隐藏']}
                    onChange={(v) => patch(r, { visible: v })} />
                </td>
                <td className="px-3 py-2.5">
                  <TriToggle value={r.required} labels={['必填', '选填']}
                    onChange={(v) => patch(r, { required: v })} />
                </td>
                <td className="px-3 py-2.5 text-xs text-gray-600">{r.default_value || '—'}</td>
                <td className="px-3 py-2.5 text-xs text-gray-500 max-w-[180px] truncate" title={r.note || ''}>{r.note || '—'}</td>
                <td className="px-3 py-2.5 text-right">
                  <button onClick={() => remove(r)} disabled={busy !== ''}
                    className="text-xs text-gray-400 hover:text-rose-600 disabled:opacity-50">删除</button>
                </td>
              </tr>
            );
          })}
          {list.length === 0 && (
            <tr><td colSpan={showCust ? 8 : 7} className="px-3 py-8 text-center text-gray-400 text-xs">
              暂无配置 —— 所有字段按代码默认
            </td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3.5">
        <p className="text-sm text-indigo-900 font-medium">这里只存「和默认不一样」的部分</p>
        <p className="text-xs text-indigo-700/85 mt-1 leading-relaxed">
          没配的字段一律走代码默认(= 现在的样子)。删掉一条配置 = 那个字段回到默认。<br />
          「不覆盖」表示这一项不管 —— 比如只想改必填、不想动显示,就把显示留在「不覆盖」。<br />
          <b>隐藏的字段会自动变成不必填</b>,不会出现"看不见却提交不了"。
        </p>
      </div>

      {msg && (
        <p className={`text-sm ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-rose-600'}`}>{msg.text}</p>
      )}

      {/* 新增 */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">新增一条配置</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <label className="text-xs text-gray-600">
            <span className="block mb-1">字段</span>
            <select value={nField} onChange={(e) => setNField(e.target.value)}
              className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white">
              <option value="">选择字段…</option>
              {fields.map((f) => (
                <option key={f.field} value={f.field}>{f.label}({f.defaultRequired})</option>
              ))}
            </select>
          </label>
          <label className="text-xs text-gray-600">
            <span className="block mb-1">作用范围</span>
            <select value={nScope} onChange={(e) => setNScope(e.target.value as any)}
              className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white">
              <option value="global">全部订单</option>
              <option value="customer">仅某个客户</option>
            </select>
          </label>
          {nScope === 'customer' && (
            <label className="text-xs text-gray-600">
              <span className="block mb-1">客户</span>
              <select value={nCust} onChange={(e) => setNCust(e.target.value)}
                className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5 bg-white">
                <option value="">选择客户…</option>
                {customers.map((c) => <option key={c.id} value={c.id}>{c.customer_name}</option>)}
              </select>
            </label>
          )}
          <label className="text-xs text-gray-600">
            <span className="block mb-1">显示</span>
            <TriToggle value={nVisible} onChange={setNVisible} labels={['显示', '隐藏']} />
          </label>
          <label className="text-xs text-gray-600">
            <span className="block mb-1">必填</span>
            <TriToggle value={nRequired} onChange={setNRequired} labels={['必填', '选填']} />
          </label>
          <label className="text-xs text-gray-600">
            <span className="block mb-1">默认值(可选)</span>
            <input value={nDefault} onChange={(e) => setNDefault(e.target.value)} placeholder="留空=不设"
              className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
          </label>
          <label className="text-xs text-gray-600 md:col-span-2">
            <span className="block mb-1">备注(为什么这么配)</span>
            <input value={nNote} onChange={(e) => setNNote(e.target.value)} placeholder="如:这个客户从不给 PO 号"
              className="w-full text-sm border border-gray-300 rounded-lg px-2 py-1.5" />
          </label>
          <div className="flex items-end">
            <button onClick={add} disabled={busy !== ''}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
              {busy === 'add' ? '保存中…' : '添加'}
            </button>
          </div>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-gray-400 py-6 text-center">加载中…</p>
      ) : (
        <>
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">全部订单({globals.length})</h2>
            <Table list={globals} />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-gray-900 mb-2">按客户({perCust.length})</h2>
            <Table list={perCust} showCust />
          </div>
        </>
      )}
    </div>
  );
}
