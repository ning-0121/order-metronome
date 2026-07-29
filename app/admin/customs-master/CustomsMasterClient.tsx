'use client';

/** 报关主数据维护:HS目录 CRUD + 公司默认值 + 客户报关抬头。存后出运单证生成自动带出(只填空缺)。 */

import { useState } from 'react';
import { upsertHsCatalog, deleteHsCatalog, saveCustomsDefaults, saveCustomerCustoms } from '@/app/actions/customs-master';

const input = 'w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none';
const DEFAULT_FIELDS: Array<[string, string]> = [
  ['customs_port', '出境关别/港口(默认 宁波港)'], ['transport', '运输方式(默认 江海运输)'],
  ['trade_mode', '监管方式(默认 一般贸易)'], ['tax_mode', '征免性质(默认 一般征税)'],
  ['trade_country', '贸易国(默认 美国)'],
];

export function CustomsMasterClient({ catalog, defaults, customers }: { catalog: any[]; defaults: Record<string, string>; customers: any[] }) {
  const [rows, setRows] = useState<any[]>(catalog);
  const [draft, setDraft] = useState<any>({ match_key: '', hs_code: '', customs_name: '', customs_spec: '', unit: '件' });
  const [defs, setDefs] = useState<Record<string, string>>(defaults);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 2500); };

  async function saveRow(r: any) {
    setBusy(r.id || 'new');
    const res = await upsertHsCatalog(r);
    setBusy('');
    if (!res.ok) { alert(res.error); return; }
    flash('✅ 已保存'); location.reload();
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 space-y-8">
      <div>
        <h1 className="text-xl font-bold text-gray-900">🛃 报关主数据</h1>
        <p className="text-sm text-gray-500 mt-1">品类少 → 目录建几十行全覆盖。出运单证(CI/报关资料)生成时按 <b>款号前缀或品名关键词</b> 自动带出 HS/报关品名;业务在出货单据里手填的永远优先。{msg && <span className="ml-2 text-emerald-600">{msg}</span>}</p>
      </div>

      {/* ① HS 目录 */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">① HS / 报关品名目录({rows.length} 行)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr><th className="px-2 py-2 text-left w-32">匹配键*</th><th className="px-2 py-2 text-left w-32">HS编码</th><th className="px-2 py-2 text-left">报关品名</th><th className="px-2 py-2 text-left">申报规格/成分</th><th className="px-2 py-2 w-16">单位</th><th className="w-20"></th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.id} className="border-t border-gray-100">
                  {(['match_key', 'hs_code', 'customs_name', 'customs_spec', 'unit'] as const).map((k) => (
                    <td key={k} className="px-1 py-1">
                      <input value={r[k] || ''} onChange={(e) => setRows((p) => p.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x))} className={input} />
                    </td>
                  ))}
                  <td className="px-1 py-1 whitespace-nowrap">
                    <button onClick={() => saveRow(r)} disabled={busy === r.id} className="text-xs text-indigo-600 hover:underline mr-2">{busy === r.id ? '…' : '存'}</button>
                    <button onClick={async () => { if (confirm(`删除「${r.match_key}」?`)) { await deleteHsCatalog(r.id); location.reload(); } }} className="text-xs text-gray-400 hover:text-red-500">删</button>
                  </td>
                </tr>
              ))}
              {/* 新增行 */}
              <tr className="border-t border-gray-200 bg-indigo-50/30">
                {(['match_key', 'hs_code', 'customs_name', 'customs_spec', 'unit'] as const).map((k) => (
                  <td key={k} className="px-1 py-1">
                    <input value={draft[k] || ''} onChange={(e) => setDraft((p: any) => ({ ...p, [k]: e.target.value }))}
                      placeholder={k === 'match_key' ? '如 legging / 文胸 / QM-' : ''} className={input} />
                  </td>
                ))}
                <td className="px-1 py-1"><button onClick={() => saveRow(draft)} disabled={busy === 'new'} className="rounded bg-indigo-600 px-2.5 py-1 text-xs text-white">{busy === 'new' ? '…' : '+ 加'}</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      {/* ③ 公司默认值 */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">③ 公司级报关默认值(留空用系统内置)</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {DEFAULT_FIELDS.map(([k, label]) => (
            <label key={k} className="block">
              <span className="text-xs text-gray-500">{label}</span>
              <input value={defs[k] || ''} onChange={(e) => setDefs((p) => ({ ...p, [k]: e.target.value }))} className={`mt-1 ${input}`} />
            </label>
          ))}
        </div>
        <button onClick={async () => { setBusy('defs'); const r = await saveCustomsDefaults(defs); setBusy(''); if (!r.ok) alert(r.error); else flash('✅ 默认值已保存'); }}
          disabled={busy === 'defs'} className="mt-3 rounded-lg bg-indigo-600 px-4 py-1.5 text-sm text-white">{busy === 'defs' ? '…' : '保存默认值'}</button>
      </section>

      {/* ② 客户报关抬头 */}
      <section className="rounded-xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-semibold text-gray-900 mb-3">② 客户报关抬头(境外收货人,一次录入单证自动带出)</h2>
        <div className="space-y-2">
          {customers.map((c) => <CustomerRow key={c.id} c={c} />)}
        </div>
      </section>
    </div>
  );
}

function CustomerRow({ c }: { c: any }) {
  const [v, setV] = useState({ consignee_name_en: c.consignee_name_en || '', customs_address: c.customs_address || '', tax_no: c.tax_no || '' });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-100 px-3 py-2">
      <span className="w-24 shrink-0 text-sm font-medium text-gray-800 truncate">{c.customer_name}</span>
      <input value={v.consignee_name_en} onChange={(e) => setV((p) => ({ ...p, consignee_name_en: e.target.value }))} placeholder="境外收货人(英文抬头)" className="flex-1 min-w-[160px] rounded border border-gray-200 px-2 py-1 text-xs" />
      <input value={v.customs_address} onChange={(e) => setV((p) => ({ ...p, customs_address: e.target.value }))} placeholder="地址(英文)" className="flex-[2] min-w-[200px] rounded border border-gray-200 px-2 py-1 text-xs" />
      <input value={v.tax_no} onChange={(e) => setV((p) => ({ ...p, tax_no: e.target.value }))} placeholder="税号" className="w-28 rounded border border-gray-200 px-2 py-1 text-xs" />
      <button onClick={async () => { setBusy(true); const r = await saveCustomerCustoms(c.id, v); setBusy(false); if (!r.ok) alert(r.error); else { setSaved(true); setTimeout(() => setSaved(false), 2000); } }}
        disabled={busy} className="rounded bg-gray-800 px-2.5 py-1 text-xs text-white disabled:opacity-50">{busy ? '…' : saved ? '✓' : '存'}</button>
    </div>
  );
}
