'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createSupplier, updateSupplier, deleteSupplier, bulkImportSuppliers } from '@/app/actions/suppliers';
import { parseExcelFile, downloadExcelTemplate, pickCell, importResultText } from '@/lib/utils/excel-import';

const EMPTY = { name: '', address: '', phone: '', contact_name: '', main_category: '', payment_method: '', net_days: '', bank_info: '', tax_id: '' };

const TEMPLATE_HEADERS = ['供应商名称*', '主营品类', '联系人', '电话', '地址', '付款方式', '账期(天)', '银行信息', '税号'];
const TEMPLATE_EXAMPLE = [['例:XX面料有限公司', '面料', '张三', '13800000000', '绍兴柯桥…', '月结', '30', '开户行+账号', '9133…']];

export function SuppliersClient({ suppliers, canBasic, canFinance, error }: {
  suppliers: any[]; canBasic: boolean; canFinance: boolean; error?: string;
}) {
  const router = useRouter();
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<any>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    summary: string;
    createdNames?: string[]; updatedNames?: string[];
    skipped?: Array<{ row: number; name: string; reason: string }>;
    failed?: Array<{ row: number; name: string; reason: string }>;
  } | null>(null);
  // 点供应商名 → 在列表里找到它、载入左侧编辑表单去补充(找不到=还没刷新到,提示重试)
  function openByName(name: string) {
    const s = (suppliers || []).find((x: any) => String(x.name).trim().toLowerCase() === name.trim().toLowerCase());
    if (s) { loadRow(s); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    else alert(`「${name}」列表里暂未找到,稍等刷新后在右侧列表点它编辑`);
  }
  const fileRef = useRef<HTMLInputElement>(null);
  // ⚡ 页面内批量录入(不用 Excel):多行表格,一键提交,复用同一套查重+报告
  const emptyBatchRow = () => ({ name: '', main_category: '', contact_name: '', phone: '', net_days: '' });
  const [batchRows, setBatchRows] = useState<any[] | null>(null);
  const [batchSaving, setBatchSaving] = useState(false);
  const setBatchCell = (i: number, k: string, v: string) =>
    setBatchRows(rows => (rows || []).map((r, x) => x === i ? { ...r, [k]: v } : r));

  async function submitBatch() {
    const rows = (batchRows || []).filter(r => String(r.name || '').trim());
    if (rows.length === 0) { alert('至少填一行供应商名称'); return; }
    setBatchSaving(true); setImportResult(null);
    const res = await bulkImportSuppliers(rows.map(r => ({
      ...r, net_days: r.net_days === '' ? null : Number(r.net_days),
    })));
    setBatchSaving(false);
    if (res.error) { alert(res.error); return; }
    setImportResult({ summary: importResultText(res), createdNames: (res as any).createdNames, updatedNames: (res as any).updatedNames, skipped: res.skipped, failed: res.failed });
    setBatchRows((res.created || 0) > 0 ? null : batchRows);   // 有成功→收起;全被跳过→留着改
    router.refresh();
  }

  function loadRow(s: any) {
    setEditId(s.id);
    setForm({
      name: s.name || '', address: s.address || '', phone: s.phone || '', contact_name: s.contact_name || '',
      main_category: s.main_category || '', payment_method: s.payment_method || '', net_days: s.net_days ?? '',
      bank_info: s.bank_info || '', tax_id: s.tax_id || '',
    });
  }
  function reset() { setEditId(null); setForm(EMPTY); }

  async function save() {
    setSaving(true);
    const payload: any = { ...form, net_days: form.net_days === '' ? null : Number(form.net_days) };
    const res = editId ? await updateSupplier(editId, payload) : await createSupplier(payload);
    setSaving(false);
    if ((res as any).error) { alert((res as any).error); return; }
    reset();
    router.refresh();
  }

  async function remove(s: any) {
    if (!confirm(`删除供应商「${s.name}」？\n无采购单引用 → 彻底删除；已有采购单 → 自动归档(历史保留,列表不再显示)。`)) return;
    const res = await deleteSupplier(s.id);
    if (res.error) { alert(res.error); return; }
    if (editId === s.id) reset();
    alert(res.deleted ? `已删除「${s.name}」` : `「${s.name}」已有采购单引用,已归档(历史采购单仍可查)`);
    router.refresh();
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';                                   // 允许重选同一文件
    if (!file) return;
    setImporting(true); setImportResult(null);
    try {
      const rows = await parseExcelFile(file);
      const inputs = rows.map(r => ({
        name: pickCell(r, ['供应商名称', '名称']),
        main_category: pickCell(r, ['主营品类', '品类']),
        contact_name: pickCell(r, ['联系人']),
        phone: pickCell(r, ['电话', '手机']),
        address: pickCell(r, ['地址']),
        payment_method: pickCell(r, ['付款方式']),
        net_days: pickCell(r, ['账期']) as any,
        bank_info: pickCell(r, ['银行信息', '开户信息']),
        tax_id: pickCell(r, ['税号']),
      })).filter(x => Object.values(x).some(v => String(v || '').trim()));  // 丢弃全空行(含示例遗留的空行)
      if (inputs.length === 0) { alert('文件里没有读到数据行 — 请用「下载模板」的格式填写'); return; }
      const res = await bulkImportSuppliers(inputs);
      if (res.error) { alert(res.error); return; }
      setImportResult({ summary: importResultText(res), createdNames: (res as any).createdNames, updatedNames: (res as any).updatedNames, skipped: res.skipped, failed: res.failed });
      router.refresh();
    } catch (err: any) {
      alert('文件解析失败:' + (err?.message || '请确认是 .xlsx/.xls/.csv 文件'));
    } finally {
      setImporting(false);
    }
  }

  const field = (key: string, label: string, editable: boolean, type = 'text') => (
    <div>
      <label className="block text-xs text-gray-500 mb-1">{label}{!editable && <span className="text-gray-300"> (无编辑权)</span>}</label>
      <input type={type} value={form[key]} disabled={!editable}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400" />
    </div>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* 表单 */}
      <div className="space-y-4">
        <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
          <h2 className="text-sm font-semibold text-gray-800">{editId ? '编辑供应商' : '新建供应商'}</h2>
          <div className="grid grid-cols-2 gap-3">
            {field('name', '名称 *', canBasic)}
            {field('main_category', '主营品类', canBasic)}
            {field('contact_name', '联系人', canBasic)}
            {field('phone', '电话', canBasic)}
          </div>
          {field('address', '地址', canBasic)}
          <div className="border-t border-gray-100 pt-3">
            <p className="text-xs font-semibold text-gray-600 mb-2">💰 财务条款（财务填）</p>
            <div className="grid grid-cols-2 gap-3">
              {field('payment_method', '付款方式', canFinance)}
              {field('net_days', '账期(天)', canFinance, 'number')}
              {field('bank_info', '银行信息', canFinance)}
              {field('tax_id', '税号', canFinance)}
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={save} disabled={saving || (!canBasic && !canFinance)}
              className="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50">
              {saving ? '保存中…' : editId ? '保存修改' : '创建供应商'}
            </button>
            {editId && <button onClick={reset} className="px-4 rounded-xl border border-gray-200 text-sm text-gray-500">取消</button>}
          </div>
        </section>

        {/* 批量录入(页面内多行) + Excel 批量导入 */}
        {canBasic && (
          <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-800">📥 批量添加供应商</h2>
            <p className="text-xs text-gray-500">几条 → 用「⚡ 批量录入」直接填;一大批 → 下载模板填好后 Excel 导入。同名自动跳过不重复。{!canFinance && '(账期等财务列需财务角色导入才生效)'}</p>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => setBatchRows(batchRows ? null : Array.from({ length: 5 }, emptyBatchRow))}
                className="px-3 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">
                {batchRows ? '收起批量录入' : '⚡ 批量录入'}
              </button>
              <button onClick={() => downloadExcelTemplate('供应商导入模板.xlsx', TEMPLATE_HEADERS, TEMPLATE_EXAMPLE)}
                className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">📄 下载模板</button>
              <button onClick={() => fileRef.current?.click()} disabled={importing}
                className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                {importing ? '导入中…' : '📥 Excel 导入'}
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
            </div>

            {batchRows && (
              <div className="space-y-2">
                <div className="overflow-x-auto">
                  <table className="text-xs w-full">
                    <thead><tr className="text-gray-400 text-left">
                      {['名称 *', '主营品类', '联系人', '电话', canFinance ? '账期(天)' : '账期(财务填)'].map(h => (
                        <th key={h} className="px-1 py-1 font-medium whitespace-nowrap">{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {batchRows.map((r, i) => (
                        <tr key={i}>
                          <td className="px-1 py-0.5"><input value={r.name} onChange={e => setBatchCell(i, 'name', e.target.value)} placeholder="XX面料有限公司" className="w-full rounded border border-gray-300 px-2 py-1.5" /></td>
                          <td className="px-1 py-0.5"><input value={r.main_category} onChange={e => setBatchCell(i, 'main_category', e.target.value)} placeholder="面料" className="w-24 rounded border border-gray-300 px-2 py-1.5" /></td>
                          <td className="px-1 py-0.5"><input value={r.contact_name} onChange={e => setBatchCell(i, 'contact_name', e.target.value)} className="w-20 rounded border border-gray-300 px-2 py-1.5" /></td>
                          <td className="px-1 py-0.5"><input value={r.phone} onChange={e => setBatchCell(i, 'phone', e.target.value)} className="w-28 rounded border border-gray-300 px-2 py-1.5" /></td>
                          <td className="px-1 py-0.5"><input type="number" value={r.net_days} disabled={!canFinance} onChange={e => setBatchCell(i, 'net_days', e.target.value)} className="w-16 rounded border border-gray-300 px-2 py-1.5 disabled:bg-gray-50" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setBatchRows([...batchRows, emptyBatchRow()])}
                    className="text-xs text-indigo-600 hover:underline">+ 加行</button>
                  <button onClick={submitBatch} disabled={batchSaving}
                    className="ml-auto px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-50">
                    {batchSaving ? '提交中…' : `提交(${batchRows.filter(r => r.name.trim()).length} 条)`}
                  </button>
                </div>
              </div>
            )}

            {importResult && (
              <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-2">
                <p className="font-medium text-gray-800">{importResult.summary}</p>
                {/* 新建 */}
                {(importResult.createdNames?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-emerald-700 font-medium">✅ 新建 {importResult.createdNames!.length}(点名字去补充其它资料):</p>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {importResult.createdNames!.map((n) => (
                        <button key={n} onClick={() => openByName(n)} className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100">{n}</button>
                      ))}
                    </div>
                  </div>
                )}
                {/* 补全 */}
                {(importResult.updatedNames?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-sky-700 font-medium">🔄 补全已有 {importResult.updatedNames!.length}(只补了空字段,点名字可再改):</p>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {importResult.updatedNames!.map((n) => (
                        <button key={n} onClick={() => openByName(n)} className="px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 hover:bg-sky-100">{n}</button>
                      ))}
                    </div>
                  </div>
                )}
                {/* 跳过(无新增信息) */}
                {(importResult.skipped?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-gray-500 font-medium">⏭ 跳过 {importResult.skipped!.length}:</p>
                    {importResult.skipped!.slice(0, 15).map((d, i) => (
                      <p key={i} className="text-gray-500">第{d.row}行「{d.name}」：{d.reason}</p>
                    ))}
                    {importResult.skipped!.length > 15 && <p className="text-gray-400">…还有 {importResult.skipped!.length - 15} 条</p>}
                  </div>
                )}
                {/* 失败 */}
                {(importResult.failed?.length ?? 0) > 0 && (
                  <div>
                    <p className="text-red-600 font-medium">❌ 失败 {importResult.failed!.length}(需修正后重导):</p>
                    {importResult.failed!.slice(0, 15).map((d, i) => (
                      <p key={i} className="text-red-600">第{d.row}行「{d.name}」：{d.reason}</p>
                    ))}
                    {importResult.failed!.length > 15 && <p className="text-gray-400">…还有 {importResult.failed!.length - 15} 条</p>}
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      {/* 列表 */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-gray-100 text-sm font-semibold text-gray-700">供应商 {suppliers.length}</div>
        {error ? <div className="p-6 text-sm text-red-600">{error}</div>
          : suppliers.length === 0 ? <div className="p-6 text-sm text-gray-400">暂无供应商</div>
          : (
          <div className="divide-y divide-gray-100 max-h-[560px] overflow-auto">
            {suppliers.map((s) => (
              <div key={s.id} className={`flex items-center px-4 py-3 hover:bg-gray-50 ${editId === s.id ? 'bg-indigo-50' : ''}`}>
                <button onClick={() => loadRow(s)} className="flex-1 min-w-0 text-left">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-medium text-gray-900 truncate">{s.name}</span>
                    <span className="text-xs text-gray-400 ml-2 shrink-0">{s.main_category || '—'}</span>
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    {s.contact_name || ''} {s.phone || ''} · 账期 {s.net_days != null ? s.net_days + '天' : '—'}
                    {s.created_by_name && <span className="text-gray-300"> · {s.created_by_name} 录入{s.created_at ? ` ${new Date(s.created_at).getMonth() + 1}/${new Date(s.created_at).getDate()}` : ''}</span>}
                  </div>
                </button>
                {canBasic && (
                  <button onClick={() => remove(s)} title="删除/归档"
                    className="ml-3 shrink-0 text-xs text-gray-300 hover:text-red-500">🗑</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
