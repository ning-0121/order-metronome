'use client';
import { useEffect, useState } from 'react';
import {
  getManufacturingOrder, upsertManufacturingOrder, updateManufacturingOrderStatus,
  generateManufacturingOrderSheet,
} from '@/app/actions/manufacturing-order';
import { LineItemMatrixEditor } from '@/components/order/LineItemMatrixEditor';

const CAT_LABEL: Record<string, string> = {
  fabric: '面料', trim: '辅料', lining: '里料', label: '标签', packing: '包装',
  print: '印花', washing: '水洗', embroidery: '绣花', service: '服务', other: '其他',
};
const STATUS_FLOW = [
  { key: 'draft', label: '草稿' }, { key: 'reviewing', label: '复核中' },
  { key: 'confirmed', label: '已确认' }, { key: 'executing', label: '已下发生产' }, { key: 'closed', label: '完成' },
];
const statusLabel = (s: string) => STATUS_FLOW.find(x => x.key === s)?.label || s;

const emptyForm = {
  print_embroidery_requirements: '', qc_focus: '', special_requirements: '',
  risk_notes: '', factory_packing_instructions: '', factory_notes: '',
};

export function ManufacturingOrderTab({ orderId }: { orderId: string }) {
  const [data, setData] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [statusBusy, setStatusBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const reload = async () => {
    const res = await getManufacturingOrder(orderId);
    if ((res as any).error) { setMsg((res as any).error); setLoading(false); return; }
    const d = (res as any).data;
    setData(d);
    if (d.mo) {
      setForm({
        print_embroidery_requirements: d.mo.print_embroidery_requirements || '',
        qc_focus: d.mo.qc_focus || '', special_requirements: d.mo.special_requirements || '',
        risk_notes: d.mo.risk_notes || '', factory_packing_instructions: d.mo.factory_packing_instructions || '',
        factory_notes: d.mo.factory_notes || '',
      });
    }
    setLoading(false);
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, [orderId]);

  const set = (k: string, v: string) => setForm(f => ({ ...f, [k]: v }));

  async function save() {
    setSaving(true); setMsg('');
    const res = await upsertManufacturingOrder(orderId, form);
    setSaving(false);
    if ((res as any).error) { setMsg('保存失败：' + (res as any).error); return; }
    setMsg('✅ 已保存');
    await reload();
  }

  async function advance(status: string) {
    setStatusBusy(true); setMsg('');
    const res = await updateManufacturingOrderStatus(orderId, status as any);
    setStatusBusy(false);
    if ((res as any).error) { setMsg((res as any).error); return; }
    await reload();
  }

  async function generate() {
    setGenerating(true); setMsg('');
    try {
      const res = await generateManufacturingOrderSheet(orderId);
      if ((res as any).error) { setMsg((res as any).error); return; }
      const { base64, fileName } = res as any;
      const bytes = atob(base64);
      const arr = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
      const blob = new Blob([arr], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fileName; document.body.appendChild(a); a.click();
      document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e: any) { setMsg('生成出错：' + (e?.message || e)); }
    finally { setGenerating(false); }
  }

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;
  if (!data) return <div className="text-center py-8 text-red-500">{msg || '加载失败'}</div>;

  const { mo, order, lineItems, bom } = data;
  const status = mo?.status || null;

  const field = (label: string, key: keyof typeof emptyForm, ph = '', rows = 2) => (
    <label className="text-xs text-gray-600 block">{label}
      <textarea value={form[key]} onChange={e => set(key, e.target.value)} placeholder={ph} rows={rows}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm resize-y" />
    </label>
  );

  return (
    <div className="space-y-5">
      {/* 顶部:MO 号 + 生命周期 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-mono font-semibold text-gray-900">{mo?.mo_no || '生产任务单（未创建）'}</span>
          {status && <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-700">{statusLabel(status)}</span>}
        </div>
        <div className="flex gap-2">
          <button onClick={() => setPreviewing(true)} disabled={!mo}
            className="text-sm px-3 py-1.5 rounded-lg bg-white text-gray-700 border border-gray-300 font-medium hover:bg-gray-50 disabled:opacity-50">
            👁 预览</button>
          <button onClick={generate} disabled={generating || !mo}
            className="text-sm px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700 disabled:opacity-50">
            {generating ? '生成中…' : '📄 下载生产任务单'}</button>
        </div>
      </div>

      {/* 预览弹窗:按范本版式渲染(数据与下载的 Excel 同源) */}
      {previewing && (
        <MoSheetPreview order={order} mo={{ ...mo, ...form }} lineItems={lineItems} bom={bom}
          onClose={() => setPreviewing(false)} onDownload={() => { setPreviewing(false); generate(); }} />
      )}

      {/* S1 富明细录入(款/色/码/件数)—— 录/改在此,下方生成任务单读它 */}
      <div className="bg-gray-50/60 rounded-xl border border-gray-200 p-3">
        <div className="text-sm font-semibold text-gray-800 mb-2">逐款明细(款 / 颜色 / 尺码 × 件数)</div>
        <p className="text-[11px] text-gray-400 mb-3">这里录/改逐款明细,是生产任务单和客户 PI 的数据源。手工录,或修正 AI 解析 PO 的结果。</p>
        <LineItemMatrixEditor orderId={orderId} />
      </div>

      {/* 生命周期条 */}
      {mo && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {STATUS_FLOW.map((s, i) => {
            const idx = STATUS_FLOW.findIndex(x => x.key === status);
            const done = i <= idx;
            return (
              <span key={s.key} className="flex items-center gap-1.5">
                <span className={`text-xs px-2 py-0.5 rounded-full ${done ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-400'}`}>{s.label}</span>
                {i < STATUS_FLOW.length - 1 && <span className="text-gray-300">›</span>}
              </span>
            );
          })}
          <span className="ml-auto flex gap-2">
            {(status === 'draft' || status === 'reviewing') && (
              <button onClick={() => advance('confirmed')} disabled={statusBusy}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700 disabled:opacity-50">✅ 确认</button>
            )}
            {status === 'confirmed' && (
              <button onClick={() => advance('executing')} disabled={statusBusy}
                className="text-xs px-3 py-1.5 rounded-lg bg-amber-600 text-white font-medium hover:bg-amber-700 disabled:opacity-50">🏭 下发生产</button>
            )}
            {status === 'executing' && (
              <button onClick={() => advance('closed')} disabled={statusBusy}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 font-medium hover:bg-gray-50 disabled:opacity-50">完成</button>
            )}
          </span>
        </div>
      )}

      {/* Customer Order 绑定(只读,单一真相不复制)*/}
      <div className="rounded-xl border border-gray-200 p-4 bg-gray-50/50">
        <div className="text-xs font-semibold text-gray-500 mb-2">客户订单（绑定 · 只读）</div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
          <div><span className="text-gray-400">客户：</span>{order.customer_name || '—'}</div>
          <div><span className="text-gray-400">订单号：</span>{order.order_no || '—'}</div>
          <div><span className="text-gray-400">款号：</span>{order.style_no || '—'}</div>
          <div><span className="text-gray-400">产品：</span>{order.product_description || '—'}</div>
          <div><span className="text-gray-400">数量：</span>{order.quantity ?? '—'}</div>
          <div><span className="text-gray-400">工厂交期：</span>{order.factory_date ? String(order.factory_date).slice(0, 10) : '—'}</div>
        </div>
        {order.packaging_type && (
          <div className="mt-2 text-xs text-gray-500"><span className="text-gray-400">包装类型：</span>{order.packaging_type === 'standard' ? '标准' : '定制'}</div>
        )}
      </div>

      {/* 款色码 + 原辅料包摘要 */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">款 × 色 × 码（{lineItems.length}）</div>
          {lineItems.length === 0 ? <p className="text-xs text-gray-400">无明细</p> : (
            <div className="space-y-1 text-xs max-h-40 overflow-y-auto">
              {lineItems.map((li: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <span className="text-gray-700 shrink-0">{[li.color_cn, li.color_en].filter(Boolean).join('/') || '—'}</span>
                  <span className="text-gray-400 truncate">{li.sizes && typeof li.sizes === 'object' ? Object.entries(li.sizes).map(([k, v]) => `${k}:${v}`).join(' ') : ''}</span>
                  <span className="ml-auto text-gray-600 shrink-0">{li.qty_pcs ?? '—'} {li.unit || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="rounded-xl border border-gray-200 p-3">
          <div className="text-xs font-semibold text-gray-500 mb-2">原辅料包（{bom.length}）</div>
          {bom.length === 0 ? <p className="text-xs text-gray-400">无明细（去「原辅料和包装」录入）</p> : (
            <div className="space-y-1 text-xs max-h-40 overflow-y-auto">
              {bom.map((b: any, i: number) => (
                <div key={i} className="flex gap-2">
                  <span className="font-medium text-gray-800 shrink-0">{b.material_name}</span>
                  <span className="text-blue-600 shrink-0">{CAT_LABEL[b.material_type] || b.material_type}</span>
                  <span className="text-gray-400 truncate">{b.color || ''} {b.placement || ''}</span>
                  <span className="ml-auto text-gray-600 shrink-0">{b.qty_per_piece ?? '—'} {b.unit || ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* MO 录入字段(业务翻译给工厂执行)*/}
      <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 space-y-3">
        <div className="text-xs font-semibold text-gray-600">工厂执行说明（业务翻译，结构化录入）</div>
        <div className="grid md:grid-cols-2 gap-3">
          {field('印绣要求', 'print_embroidery_requirements')}
          {field('QC 重点', 'qc_focus')}
          {field('特殊要求', 'special_requirements')}
          {field('风险提醒', 'risk_notes')}
          {field('内部包装说明（≠客户原始要求）', 'factory_packing_instructions')}
          {field('其他下厂说明', 'factory_notes')}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={saving}
            className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '保存中…' : mo ? '保存' : '创建生产任务单'}</button>
          {msg && <span className="text-xs text-gray-500">{msg}</span>}
        </div>
      </div>
    </div>
  );
}

/** 生产任务单预览 —— 按范本版式(每款一页),数据与下载 Excel 同源。 */
function MoSheetPreview({ order, mo, lineItems, bom, onClose, onDownload }: {
  order: any; mo: any; lineItems: any[]; bom: any[]; onClose: () => void; onDownload: () => void;
}) {
  const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL', '2XL', 'XXXL', '3XL', '4XL', '5XL', '6XL'];
  const sortSizes = (keys: string[]) => [...keys].sort((a, b) => {
    const ia = SIZE_ORDER.indexOf(a.toUpperCase()), ib = SIZE_ORDER.indexOf(b.toUpperCase());
    if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });

  // 按款分组(与服务端生成同口径)
  const groups: { style_no: string; product_name: string; image_url: string; items: any[] }[] = [];
  for (const li of lineItems) {
    const key = li.style_no || order.style_no || '';
    let g = groups.find(x => x.style_no === key);
    if (!g) { g = { style_no: key, product_name: li.product_name || order.product_description || '', image_url: li.image_url || '', items: [] }; groups.push(g); }
    if (!g.image_url && li.image_url) g.image_url = li.image_url;
    g.items.push(li);
  }
  if (groups.length === 0) groups.push({ style_no: order.style_no || '', product_name: order.product_description || '', image_url: '', items: [] });

  const fabrics = bom.filter((b: any) => b.material_type === 'fabric');
  const fabricText = (f: any) => f ? [f.material_name, f.color].filter(Boolean).join(' ') : '';
  const fabricUsage = (f: any) => (f && f.qty_per_piece != null) ? `${f.qty_per_piece}${f.unit || ''}/件` : '';
  const bomJoin = (types: string[]) => bom
    .filter((b: any) => types.includes(b.material_type))
    .map((b: any) => [b.material_name, b.color, b.qty_per_piece != null ? `${b.qty_per_piece}${b.unit || ''}/件` : ''].filter(Boolean).join(' '))
    .join('；');
  const joinTxt = (...vs: any[]) => vs.filter(Boolean).join('；');
  const today = new Date().toISOString().slice(0, 10);
  const fmtD = (v: any) => (v ? String(v).slice(0, 10) : '');

  const td = 'border border-gray-400 px-2 py-1 text-center align-middle';
  const tdL = 'border border-gray-400 px-2 py-1 text-left align-middle';

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-xl max-w-4xl w-full my-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="sticky top-0 bg-white rounded-t-xl border-b border-gray-200 px-4 py-3 flex items-center justify-between z-10">
          <span className="text-sm font-semibold text-gray-800">👁 生产任务单预览（{groups.length} 款,与下载 Excel 同源）</span>
          <div className="flex gap-2">
            <button onClick={onDownload} className="text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white font-medium hover:bg-emerald-700">📄 下载 Excel</button>
            <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:bg-gray-50">关闭</button>
          </div>
        </div>

        <div className="p-4 space-y-8">
          {groups.map((g, gi) => {
            const sizeSet = new Set<string>();
            for (const li of g.items) if (li.sizes && typeof li.sizes === 'object') for (const k of Object.keys(li.sizes)) sizeSet.add(k);
            const sizeKeys = sortSizes([...sizeSet]).slice(0, 10);
            const styleTotal = g.items.reduce((a, li) => a + (Number(li.qty_pcs) || 0), 0) || (groups.length === 1 ? order.quantity : 0);
            const reqRows: [string, string][] = [
              ['成衣辅料：', bomJoin(['trim', 'lining', 'label'])],
              ['包装辅料：', bomJoin(['packing'])],
              ['裁剪要求：', ''],
              ['缝制要求：', joinTxt(mo.print_embroidery_requirements, mo.special_requirements)],
              ['检验要求：', mo.qc_focus || ''],
              ['包装要求', mo.factory_packing_instructions || ''],
              ['装箱要求', ''],
              ['注意事项', joinTxt(mo.risk_notes, mo.factory_notes)],
            ];
            return (
              <div key={gi} className="text-[13px] text-gray-900" style={{ fontFamily: 'SimSun, 宋体, serif' }}>
                <div className="text-center text-xl font-bold">义乌市绮陌服饰有限公司</div>
                <div className="text-center text-base mb-1">生产任务单</div>
                <div className="flex flex-wrap gap-x-6 border-b border-gray-400 pb-1 mb-0">
                  <span>订单号：<b>{order.order_no || '—'}</b></span>
                  <span>总数量: <b>{styleTotal ? `${styleTotal}件` : '—'}</b></span>
                  <span>制单日期：{today}</span>
                  <span>发货日期：{fmtD(order.etd) || '—'}</span>
                </div>
                <table className="w-full border-collapse mt-0">
                  <tbody>
                    <tr>
                      <td className={`${td} w-28 whitespace-nowrap`}>款 号</td>
                      <td className={`${td} font-bold`} colSpan={5}>{g.style_no || '—'}</td>
                      <td className={`${td} w-24 whitespace-nowrap`}>品 名</td>
                      <td className={td} colSpan={4}>{g.product_name || '—'}</td>
                    </tr>
                    <tr>
                      <td className={td}>主 面 料</td><td className={td} colSpan={5}>{fabricText(fabrics[0])}</td>
                      <td className={td}>网 纱</td><td className={td} colSpan={4}>{fabricText(fabrics[1])}</td>
                    </tr>
                    <tr>
                      <td className={td}>主面料用料</td><td className={td} colSpan={5}>{fabricUsage(fabrics[0])}</td>
                      <td className={td}>网纱用料</td><td className={td} colSpan={4}>{fabricUsage(fabrics[1])}</td>
                    </tr>
                    <tr>
                      <td className={td}>分 类</td>
                      <td className={td} colSpan={6}>尺码明细表单位：CM（尺寸工厂按样衣手填）</td>
                      <td className={td} colSpan={4}>产品图片</td>
                    </tr>
                    <tr>
                      <td className={td}>尺 码</td>
                      {sizeKeys.slice(0, 5).map(s => <td key={s} className={td}>{s}</td>)}
                      {Array.from({ length: Math.max(0, 5 - sizeKeys.length) }).map((_, i) => <td key={i} className={td}></td>)}
                      <td className={td}>公差</td>
                      <td className={`${td} align-middle`} colSpan={4} rowSpan={2}>
                        {g.image_url
                          ? <img src={g.image_url} alt="产品图" className="max-h-56 mx-auto object-contain" />
                          : <span className="text-gray-400">（未上传产品图）</span>}
                      </td>
                    </tr>
                    <tr>
                      <td className={`${td} text-gray-400`} colSpan={7}>（胸围/肩宽/领宽…等尺寸行,下载后按范本填写）</td>
                    </tr>
                  </tbody>
                </table>

                {/* 颜色 × 订单数量 */}
                <table className="w-full border-collapse mt-2">
                  <tbody>
                    <tr>
                      <td className={`${td} w-28`}>颜色</td>
                      <td className={td} colSpan={Math.max(sizeKeys.length, 1)}>订单数量</td>
                    </tr>
                    <tr>
                      <td className={td}></td>
                      {sizeKeys.map(s => <td key={s} className={td}>{s}</td>)}
                      {sizeKeys.length === 0 && <td className={td}></td>}
                    </tr>
                    {g.items.map((li, ci) => (
                      <tr key={ci}>
                        <td className={td}>{[li.color_cn, li.color_en].filter(Boolean).join('/') || '—'}</td>
                        {sizeKeys.map(s => <td key={s} className={td}>{(li.sizes && typeof li.sizes === 'object' && Number(li.sizes[s])) || ''}</td>)}
                        {sizeKeys.length === 0 && <td className={td}></td>}
                      </tr>
                    ))}
                    {g.items.length === 0 && (
                      <tr><td className={`${td} text-gray-400`} colSpan={Math.max(sizeKeys.length, 1) + 1}>（无逐款明细,先在上方「逐款明细」录入）</td></tr>
                    )}
                    <tr>
                      <td className={td}>每箱件数</td>
                      <td className={`${td} text-gray-400`} colSpan={Math.max(sizeKeys.length, 1)}>（下载后填,箱数自动算）</td>
                    </tr>
                  </tbody>
                </table>

                {/* 工厂要求 */}
                <table className="w-full border-collapse mt-2">
                  <tbody>
                    {reqRows.map(([label, text], i) => (
                      <tr key={i}>
                        <td className={`${td} w-28 whitespace-nowrap`}>{label}</td>
                        <td className={`${tdL} ${text ? '' : 'text-gray-300'}`}>{text || '（留白手填）'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="border-t border-gray-400 mt-1 pt-1">抄送:采购、面料仓、辅料仓{order.factory_name ? `、${order.factory_name}` : ''}、QC、包装组长、打包组长</div>
                <div className="flex gap-16 mt-1">
                  <span>制单：</span><span>跟单：</span><span>批准：</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
