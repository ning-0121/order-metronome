'use client';

/**
 * 打样申请单(2026-07-27 CEO)——新建样品单页按公司「打样申请单」纸质样式录入,
 * 而不是套用大货单表单(客户PO/贸易条款/套装等对打样无意义)。
 * 字段:客户/样衣性质/款式描述/款号/尺码/总数量/面料1·2(含克重)/辅料1·2·3/特殊要求/备注/贴样说明/颜色×尺码表。
 * 复用 createOrder(走 order_purpose=sample → 8 节点打样流程 + 负责人分配);样品专属字段落 sample_request jsonb。
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CustomerSelect } from '@/components/CustomerSelect';
import { createOrder, preGenerateOrderNo } from '@/app/actions/orders';

const SAMPLE_NATURES = ['初次打样', '款式样', '销售样', '产前样(PP)', '船样', '齐色齐码样', '其他'];
const DEFAULT_SIZES = ['XS', 'S', 'M', 'L'];
const SIZE_POOL = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', 'F'];

type ColorRow = { color_cn: string; qty: Record<string, string> };

export function SampleRequestForm() {
  const router = useRouter();
  const [orderNo, setOrderNo] = useState<string | null>(null);
  const [orderNoErr, setOrderNoErr] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');

  const [internalNo, setInternalNo] = useState('');
  const [dueDate, setDueDate] = useState('');   // 打样交期(目标完成日)= 排期锚点 → factory_date
  const [sampleNature, setSampleNature] = useState(SAMPLE_NATURES[0]);
  const [styleNo, setStyleNo] = useState('');
  const [styleDesc, setStyleDesc] = useState('');
  const [sizes, setSizes] = useState<string[]>(DEFAULT_SIZES);
  const [colors, setColors] = useState<ColorRow[]>([{ color_cn: '', qty: {} }]);
  const [fabric1, setFabric1] = useState({ name: '', gsm: '' });
  const [fabric2, setFabric2] = useState({ name: '', gsm: '' });
  const [trims, setTrims] = useState(['', '', '']);
  const [special, setSpecial] = useState('');
  const [notes, setNotes] = useState('');
  const [swatchNote, setSwatchNote] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    preGenerateOrderNo().then((r) => {
      if (r.orderNo) setOrderNo(r.orderNo);
      else setOrderNoErr(r.error || '系统单号生成失败,请刷新');
    });
  }, []);

  const totalQty = colors.reduce((s, c) => s + sizes.reduce((ss, sz) => ss + (Number(c.qty[sz]) || 0), 0), 0);

  const setColorQty = (ci: number, sz: string, v: string) =>
    setColors((prev) => prev.map((c, i) => (i === ci ? { ...c, qty: { ...c.qty, [sz]: v } } : c)));
  const setColorName = (ci: number, v: string) =>
    setColors((prev) => prev.map((c, i) => (i === ci ? { ...c, color_cn: v } : c)));
  const addColor = () => setColors((p) => [...p, { color_cn: '', qty: {} }]);
  const removeColor = (ci: number) => setColors((p) => (p.length > 1 ? p.filter((_, i) => i !== ci) : p));
  const toggleSize = (sz: string) =>
    setSizes((p) => (p.includes(sz) ? p.filter((s) => s !== sz) : [...p, sz].sort((a, b) => SIZE_POOL.indexOf(a) - SIZE_POOL.indexOf(b))));

  async function submit() {
    setErr('');
    if (!orderNo) { setErr('系统单号还没生成,请稍候再试'); return; }
    if (!customerId) { setErr('请先选择客户'); return; }
    if (!internalNo.trim()) { setErr('请填写内部单号(订单册编号)'); return; }
    if (!dueDate) { setErr('请填写打样交期(目标完成日)'); return; }
    if (!styleNo.trim() && !styleDesc.trim()) { setErr('请至少填款号或款式描述'); return; }

    const styleColors = colors
      .map((c) => ({
        color_cn: c.color_cn.trim() || null,
        sizes: Object.fromEntries(sizes.map((sz) => [sz, Number(c.qty[sz]) || 0]).filter(([, v]) => (v as number) > 0)),
      }))
      .filter((c) => c.color_cn || Object.keys(c.sizes).length > 0);

    const lineItems = [{ style_no: styleNo || null, product_name: styleDesc || null, colors: styleColors }];

    const fd = new FormData();
    fd.set('customer_id', customerId);
    fd.set('customer_name', customerName);
    fd.set('order_purpose', 'sample');
    fd.set('order_type', 'sample');
    fd.set('incoterm', 'FOB');          // 打样无贸易条款,给默认满足校验
    fd.set('sample_phase', 'confirmed'); // 走 8 节点打样流程
    fd.set('internal_order_no', internalNo.trim());
    fd.set('style_no', styleNo.trim());
    fd.set('factory_date', dueDate);   // 打样交期作排期锚点(createOrder 必填)
    fd.set('product_description', styleDesc.trim());
    fd.set('sizes', sizes.join(','));
    fd.set('total_quantity', String(totalQty));   // createOrder 读 total_quantity(不是 quantity)
    fd.set('quantity_unit', '件');                 // 打样按件
    fd.set('style_count', '1');                    // 打样单一款
    fd.set('color_count', String(styleColors.length || 1));  // 颜色行数
    fd.set('line_items', JSON.stringify(lineItems));
    fd.set('notes', notes.trim());
    fd.set('sample_request', JSON.stringify({
      sample_nature: sampleNature,
      fabrics: [fabric1, fabric2].filter((f) => f.name.trim()).map((f) => ({ name: f.name.trim(), gsm: f.gsm.trim() })),
      trims: trims.map((t) => t.trim()).filter(Boolean),
      special_requirements: special.trim(),
      swatch_note: swatchNote.trim(),
    }));

    setSubmitting(true);
    try {
      const res = await createOrder(fd, orderNo);
      if (!res.ok) { setErr(res.error || '建单失败'); setSubmitting(false); return; }
      router.push(`/orders/${res.orderId}`);
    } catch (e: any) {
      setErr('建单出错:' + (e?.message || '请重试'));
      setSubmitting(false);
    }
  }

  const label = 'text-xs font-medium text-gray-500';
  const input = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none';

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="mb-4 text-center">
        <div className="text-xs text-gray-400">义乌绮陌服饰有限公司</div>
        <h1 className="text-2xl font-bold tracking-widest text-gray-900">打 样 申 请 单</h1>
        <div className="mt-1 text-xs text-gray-500">
          系统单号:{orderNo ? <b className="font-mono text-indigo-700">{orderNo}</b> : (orderNoErr ? <span className="text-red-500">{orderNoErr}</span> : '生成中…')}
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 space-y-5">
        {/* 客户 / 样衣性质 */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className={label}>客户 <span className="text-red-500">*</span></div>
            <div className="mt-1"><CustomerSelect onSelect={(c) => { setCustomerId(c?.id || ''); setCustomerName(c?.customer_name || ''); }} /></div>
          </div>
          <div>
            <div className={label}>样衣性质</div>
            <select value={sampleNature} onChange={(e) => setSampleNature(e.target.value)} className={`mt-1 ${input}`}>
              {SAMPLE_NATURES.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        </div>

        {/* 内部单号 / 款号 */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className={label}>内部单号(订单册编号) <span className="text-red-500">*</span></div>
            <input value={internalNo} onChange={(e) => setInternalNo(e.target.value)} placeholder="订单册编号" className={`mt-1 ${input}`} />
          </div>
          <div>
            <div className={label}>款号</div>
            <input value={styleNo} onChange={(e) => setStyleNo(e.target.value)} placeholder="款号 style#" className={`mt-1 ${input}`} />
          </div>
        </div>

        {/* 打样交期(排期锚点) */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className={label}>打样交期(目标完成日) <span className="text-red-500">*</span></div>
            <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={`mt-1 ${input}`} />
            <div className="mt-0.5 text-[11px] text-gray-400">样品什么时候要完成/寄出。8 个打样节点按这个日期倒排。</div>
          </div>
        </div>

        {/* 款式描述 */}
        <div>
          <div className={label}>款式描述</div>
          <input value={styleDesc} onChange={(e) => setStyleDesc(e.target.value)} placeholder="款式/品名描述" className={`mt-1 ${input}`} />
        </div>

        {/* 尺码选择 + 颜色×尺码 表 */}
        <div>
          <div className="flex items-center justify-between">
            <div className={label}>尺码 · 颜色分色数量表</div>
            <div className="text-xs text-gray-500">总数量 <b className="text-indigo-700">{totalQty}</b></div>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {SIZE_POOL.map((sz) => (
              <button key={sz} type="button" onClick={() => toggleSize(sz)}
                className={`px-2 py-0.5 rounded text-xs border ${sizes.includes(sz) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-gray-300 text-gray-500 hover:bg-gray-50'}`}>
                {sz}
              </button>
            ))}
          </div>
          <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500">
                <tr>
                  <th className="px-2 py-1.5 text-left min-w-[110px]">颜色</th>
                  {sizes.map((sz) => <th key={sz} className="px-2 py-1.5 text-center w-14">{sz}</th>)}
                  <th className="px-2 py-1.5 text-center w-12">小计</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {colors.map((c, ci) => {
                  const sub = sizes.reduce((s, sz) => s + (Number(c.qty[sz]) || 0), 0);
                  return (
                    <tr key={ci} className="border-t border-gray-100">
                      <td className="px-2 py-1">
                        <input value={c.color_cn} onChange={(e) => setColorName(ci, e.target.value)} placeholder="颜色"
                          className="w-full rounded border border-gray-200 px-1.5 py-1 text-xs focus:border-indigo-400 focus:outline-none" />
                      </td>
                      {sizes.map((sz) => (
                        <td key={sz} className="px-1 py-1">
                          <input value={c.qty[sz] || ''} onChange={(e) => setColorQty(ci, sz, e.target.value)} inputMode="numeric"
                            className="w-12 rounded border border-gray-200 px-1 py-1 text-xs text-center focus:border-indigo-400 focus:outline-none" />
                        </td>
                      ))}
                      <td className="px-2 py-1 text-center text-xs font-semibold text-gray-700">{sub || ''}</td>
                      <td className="px-1 py-1 text-center">
                        <button type="button" onClick={() => removeColor(ci)} className="text-gray-300 hover:text-red-500 text-xs">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" onClick={addColor} className="mt-1.5 text-xs text-indigo-600 hover:underline">+ 加一行颜色</button>
        </div>

        {/* 面料 */}
        <div className="space-y-2">
          <div className={label}>面辅料信息</div>
          {[[fabric1, setFabric1, '面料1'], [fabric2, setFabric2, '面料2']].map(([f, setF, lbl]: any, i) => (
            <div key={i} className="flex gap-2">
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={lbl} className={`flex-1 ${input}`} />
              <input value={f.gsm} onChange={(e) => setF({ ...f, gsm: e.target.value })} placeholder="克重 g/㎡" className="w-28 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none" />
            </div>
          ))}
          {trims.map((t, i) => (
            <input key={i} value={t} onChange={(e) => setTrims((p) => p.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`辅料${i + 1}`} className={input} />
          ))}
        </div>

        {/* 特殊要求 / 备注 / 贴样 */}
        <div>
          <div className={label}>特殊要求</div>
          <textarea value={special} onChange={(e) => setSpecial(e.target.value)} rows={2} className={`mt-1 ${input}`} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <div className={label}>备注</div>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className={`mt-1 ${input}`} />
          </div>
          <div>
            <div className={label}>贴样处说明(布样/辅料样另附)</div>
            <textarea value={swatchNote} onChange={(e) => setSwatchNote(e.target.value)} rows={2} placeholder="如:布样已贴 / 见附件" className={`mt-1 ${input}`} />
          </div>
        </div>

        {err && <div className="rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-sm text-red-600 whitespace-pre-wrap">{err}</div>}

        <div className="flex items-center justify-end gap-3 pt-1">
          <button type="button" onClick={() => router.back()} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50">取消</button>
          <button type="button" onClick={submit} disabled={submitting || !orderNo}
            className="rounded-lg bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {submitting ? '提交中…' : '✅ 提交打样申请'}
          </button>
        </div>
      </div>
    </div>
  );
}
