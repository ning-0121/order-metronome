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
  const [importResult, setImportResult] = useState<{ summary: string; details: Array<{ row: number; name: string; reason: string }> } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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
      setImportResult({ summary: importResultText(res), details: [...(res.skipped || []), ...(res.failed || [])] });
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

        {/* Excel 批量导入 */}
        {canBasic && (
          <section className="bg-white rounded-xl border border-gray-200 p-5 space-y-3">
            <h2 className="text-sm font-semibold text-gray-800">📥 Excel 批量导入</h2>
            <p className="text-xs text-gray-500">按模板格式填写后上传,同名供应商自动跳过不重复。{!canFinance && '(付款方式/账期等财务列需财务角色导入才生效)'}</p>
            <div className="flex gap-2">
              <button onClick={() => downloadExcelTemplate('供应商导入模板.xlsx', TEMPLATE_HEADERS, TEMPLATE_EXAMPLE)}
                className="px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50">📄 下载模板</button>
              <button onClick={() => fileRef.current?.click()} disabled={importing}
                className="px-3 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50">
                {importing ? '导入中…' : '📥 选择 Excel 导入'}
              </button>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImportFile} />
            </div>
            {importResult && (
              <div className="text-xs bg-gray-50 border border-gray-200 rounded-lg p-3 space-y-1">
                <p className="font-medium text-gray-800">{importResult.summary}</p>
                {importResult.details.slice(0, 20).map((d, i) => (
                  <p key={i} className="text-gray-500">第{d.row}行「{d.name}」：{d.reason}</p>
                ))}
                {importResult.details.length > 20 && <p className="text-gray-400">…还有 {importResult.details.length - 20} 条</p>}
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
