'use client';
import { useEffect, useState, useCallback } from 'react';
import {
  listProducts, createProduct, getProductDetail, createVariant,
  addBomTemplateRow, deleteBomTemplateRow, confirmDefinition,
} from '@/app/actions/products';
import { listMaterialMaster } from '@/app/actions/material-master';

const CAT = ['fabric', 'trim', 'packing', 'print', 'washing', 'embroidery', 'service', 'other'];
const CAT_LABEL: Record<string, string> = { fabric: '面料', trim: '辅料', packing: '包装', print: '印花', washing: '水洗', embroidery: '绣花', service: '服务', other: '其他' };
const ROLE = ['main_fabric', 'lining', 'trim', 'packing', 'print', 'embroidery', 'washing', 'service', 'other'];
const ROLE_LABEL: Record<string, string> = { main_fabric: '主面料', lining: '里料', trim: '辅料', packing: '包装', print: '印花', embroidery: '绣花', washing: '水洗', service: '服务', other: '其他' };
const STATUS_LABEL: Record<string, string> = { developing: '开发中', sampling: '打样', confirmed: '已确认', active: '量产款', archived: '归档', draft: '草稿', superseded: '旧版' };

const emptyProduct = { product_name: '', product_code: '', category: '', season: '', brand: '', target_customer: '' };
const emptyVariant = { variant_code: '', country: '', market: '', brand: '', customer: '' };
const emptyBom = { material_master_id: '', material_name: '', category: 'fabric', bom_role: 'main_fabric', unit: '', development_consumption: '', production_consumption: '', default_color: '', default_placement: '', special_requirements: '' };

export default function ProductsPage() {
  const [list, setList] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [np, setNp] = useState(emptyProduct);
  const [msg, setMsg] = useState('');

  const [selId, setSelId] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);

  // 子表单
  const [vf, setVf] = useState(emptyVariant);
  const [bf, setBf] = useState(emptyBom);
  const [mm, setMm] = useState<any[]>([]);
  const [mmSearch, setMmSearch] = useState('');

  const load = useCallback(async () => {
    const res = await listProducts(search.trim() || undefined);
    if (!(res as any).error) setList((res as any).data || []);
    setLoading(false);
  }, [search]);
  useEffect(() => { const t = setTimeout(load, 250); return () => clearTimeout(t); }, [load]);

  const openDetail = async (id: string) => {
    setSelId(id); setDetail(null); setVf(emptyVariant); setBf(emptyBom);
    const res = await getProductDetail(id);
    if (!(res as any).error) setDetail((res as any).data);
  };

  // 实时搜 Material Master(给 BOM 选物料)
  useEffect(() => {
    if (!selId) return;
    const t = setTimeout(async () => {
      const res = await listMaterialMaster({ search: mmSearch.trim() || undefined });
      setMm((res as any).data || []);
    }, 250);
    return () => clearTimeout(t);
  }, [mmSearch, selId]);

  async function saveProduct() {
    const res = await createProduct(np);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setShowNew(false); setNp(emptyProduct); setMsg('✅ 已建款'); await load();
    openDetail((res as any).data.id);
  }
  async function saveVariant() {
    if (!detail) return;
    const res = await createVariant(detail.product.id, vf);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setVf(emptyVariant); await openDetail(detail.product.id);
  }
  function pickMaster(m: any) {
    setBf(f => ({ ...f, material_master_id: m.id, material_name: m.material_name, category: m.category || f.category, unit: m.default_unit || f.unit, development_consumption: m.default_consumption ?? f.development_consumption }));
  }
  async function saveBom() {
    if (!detail?.definition) { setMsg('该款无 Definition'); return; }
    if (!bf.material_name.trim()) { setMsg('物料名称不能为空'); return; }
    const res = await addBomTemplateRow(detail.definition.id, bf);
    if ((res as any).error) { setMsg((res as any).error); return; }
    setBf(emptyBom); setMmSearch(''); await openDetail(detail.product.id);
  }
  async function delBom(id: string) {
    await deleteBomTemplateRow(id); if (detail) await openDetail(detail.product.id);
  }
  async function confirmDef() {
    if (!detail?.definition) return;
    await confirmDefinition(detail.definition.id); await openDetail(detail.product.id);
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900">🧬 产品款库 · Product Domain</h1>
          <p className="text-xs text-gray-500 mt-0.5">Digital Product Definition · 款 → Variant → Definition → BOM Template</p>
        </div>
        <button onClick={() => { setShowNew(true); setNp(emptyProduct); }} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700">+ 新建款</button>
      </div>
      {msg && <p className="text-xs text-gray-600">{msg}</p>}

      <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜款名/款号/品牌…" className="w-full md:w-80 rounded-lg border border-gray-300 px-3 py-2 text-sm" />

      {showNew && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 grid md:grid-cols-3 gap-3">
          {(['product_name', 'product_code', 'category', 'season', 'brand', 'target_customer'] as const).map(k => (
            <input key={k} value={(np as any)[k]} onChange={e => setNp(f => ({ ...f, [k]: e.target.value }))}
              placeholder={{ product_name: '款名 *', product_code: '款号', category: '品类', season: '季节', brand: '品牌', target_customer: '目标客户' }[k]}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          ))}
          <div className="md:col-span-3 flex gap-2">
            <button onClick={saveProduct} disabled={!np.product_name.trim()} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">保存</button>
            <button onClick={() => setShowNew(false)} className="px-4 py-2 rounded-lg border text-sm text-gray-500">取消</button>
          </div>
        </div>
      )}

      {/* 款列表 */}
      {loading ? <p className="text-gray-400 text-sm">加载中…</p> : (
        <div className="grid md:grid-cols-2 gap-2">
          {list.map(p => (
            <button key={p.id} onClick={() => openDetail(p.id)} className={`text-left rounded-xl border p-3 hover:border-indigo-300 ${selId === p.id ? 'border-indigo-400 bg-indigo-50/40' : 'border-gray-200'}`}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-indigo-600">{p.product_code || '—'}</span>
                <span className="font-medium text-gray-900">{p.product_name}</span>
                <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{STATUS_LABEL[p.status] || p.status}</span>
              </div>
              <div className="text-xs text-gray-400 mt-1">{[p.brand, p.season, p.category, p.target_customer].filter(Boolean).join(' · ') || '—'}</div>
            </button>
          ))}
          {list.length === 0 && <p className="text-gray-400 text-sm">暂无款,点「新建款」。</p>}
        </div>
      )}

      {/* 款详情 */}
      {detail && (
        <div className="rounded-xl border border-gray-200 p-4 space-y-5">
          <div className="text-sm font-semibold text-gray-900">{detail.product.product_code || ''} {detail.product.product_name}
            <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{STATUS_LABEL[detail.product.status]}</span></div>

          {/* Variants */}
          <div>
            <div className="text-xs font-semibold text-gray-500 mb-2">变体 Variants（{detail.variants.length}）</div>
            <div className="space-y-1 mb-2">
              {detail.variants.map((v: any) => (
                <div key={v.id} className="text-xs text-gray-700 flex gap-2"><span className="font-mono text-indigo-500">{v.variant_code || '—'}</span><span>{[v.country, v.market, v.brand, v.customer].filter(Boolean).join(' / ') || '默认'}</span></div>
              ))}
              {detail.variants.length === 0 && <p className="text-xs text-gray-400">无变体</p>}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {(['variant_code', 'country', 'market', 'brand', 'customer'] as const).map(k => (
                <input key={k} value={(vf as any)[k]} onChange={e => setVf(f => ({ ...f, [k]: e.target.value }))} placeholder={{ variant_code: '变体码', country: '国家', market: '市场', brand: '品牌', customer: '客户' }[k]} className="rounded border border-gray-300 px-2 py-1.5 text-xs" />
              ))}
            </div>
            <button onClick={saveVariant} className="mt-2 px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 text-xs font-medium hover:bg-indigo-50">+ 加变体</button>
          </div>

          {/* Definition + BOM Template */}
          {detail.definition && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <div className="text-xs font-semibold text-gray-500">BOM Template（Definition v{detail.definition.version} · {STATUS_LABEL[detail.definition.status]}）</div>
                {detail.definition.status !== 'active' && <button onClick={confirmDef} className="text-xs px-2 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700">确认 Definition</button>}
              </div>
              <div className="overflow-x-auto mb-2">
                <table className="w-full text-xs">
                  <thead><tr className="text-gray-400 text-left">{['物料', '采购分类', '结构角色', '单位', '开发单耗', '大货单耗', '颜色', ''].map(h => <th key={h} className="py-1 pr-2 font-medium">{h}</th>)}</tr></thead>
                  <tbody>
                    {detail.bom.map((b: any) => (
                      <tr key={b.id} className="border-t border-gray-50">
                        <td className="py-1 pr-2 font-medium text-gray-800">{b.material_master_id && '🔗'} {b.material_name}</td>
                        <td className="py-1 pr-2 text-gray-500">{CAT_LABEL[b.category] || b.category || '—'}</td>
                        <td className="py-1 pr-2 text-blue-600">{ROLE_LABEL[b.bom_role] || b.bom_role || '—'}</td>
                        <td className="py-1 pr-2 text-gray-500">{b.unit || '—'}</td>
                        <td className="py-1 pr-2 text-gray-600">{b.development_consumption ?? '—'}</td>
                        <td className="py-1 pr-2 text-gray-900 font-medium">{b.production_consumption ?? '—'}</td>
                        <td className="py-1 pr-2 text-gray-500">{b.default_color || '—'}</td>
                        <td className="py-1 pr-2"><button onClick={() => delBom(b.id)} className="text-red-500 hover:underline">删</button></td>
                      </tr>
                    ))}
                    {detail.bom.length === 0 && <tr><td colSpan={8} className="py-2 text-gray-400">无 BOM 行</td></tr>}
                  </tbody>
                </table>
              </div>

              {/* 加 BOM 行 */}
              <div className="rounded-lg border border-gray-200 p-3 space-y-2 bg-gray-50/50">
                <div className="text-xs font-medium text-gray-600">加物料(可从主数据选)</div>
                <input value={mmSearch} onChange={e => setMmSearch(e.target.value)} placeholder="搜物料主数据…" className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs" />
                {mm.length > 0 && (
                  <div className="max-h-24 overflow-y-auto bg-white rounded border border-gray-100 divide-y">
                    {mm.slice(0, 6).map((m: any) => (
                      <button key={m.id} onClick={() => pickMaster(m)} className="w-full text-left px-2 py-1 text-xs hover:bg-indigo-50">
                        <span className="font-mono text-indigo-500">{m.material_code}</span> {m.material_name} <span className="text-gray-400">{m.specification || ''}</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  <input value={bf.material_name} onChange={e => setBf(f => ({ ...f, material_name: e.target.value }))} placeholder="物料名 *" className="rounded border border-gray-300 px-2 py-1.5 text-xs" />
                  <select value={bf.category} onChange={e => setBf(f => ({ ...f, category: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-xs">{CAT.map(c => <option key={c} value={c}>采购:{CAT_LABEL[c]}</option>)}</select>
                  <select value={bf.bom_role} onChange={e => setBf(f => ({ ...f, bom_role: e.target.value }))} className="rounded border border-gray-300 px-2 py-1.5 text-xs">{ROLE.map(r => <option key={r} value={r}>角色:{ROLE_LABEL[r]}</option>)}</select>
                  <input value={bf.unit} onChange={e => setBf(f => ({ ...f, unit: e.target.value }))} placeholder="单位" className="rounded border border-gray-300 px-2 py-1.5 text-xs" />
                  <input value={bf.development_consumption} onChange={e => setBf(f => ({ ...f, development_consumption: e.target.value }))} placeholder="开发单耗" type="number" className="rounded border border-gray-300 px-2 py-1.5 text-xs" />
                  <input value={bf.production_consumption} onChange={e => setBf(f => ({ ...f, production_consumption: e.target.value }))} placeholder="大货单耗" type="number" className="rounded border border-gray-300 px-2 py-1.5 text-xs" />
                  <input value={bf.default_color} onChange={e => setBf(f => ({ ...f, default_color: e.target.value }))} placeholder="默认颜色" className="rounded border border-gray-300 px-2 py-1.5 text-xs" />
                  <input value={bf.special_requirements} onChange={e => setBf(f => ({ ...f, special_requirements: e.target.value }))} placeholder="特殊要求" className="rounded border border-gray-300 px-2 py-1.5 text-xs" />
                </div>
                <button onClick={saveBom} disabled={!bf.material_name.trim()} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium disabled:opacity-50">+ 加 BOM 行</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
