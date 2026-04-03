'use client';
import { useEffect, useState, useCallback } from 'react';
import { getShipmentConfirmation, createShipmentConfirmation, signShipment } from '@/app/actions/shipments';
import { getShipmentBatches, enableSplitShipment, updateShipmentBatch } from '@/app/actions/shipment-batches';

interface SignerConfig {
  role: string;
  field: string;
  signedAt: string;
  signRole: 'sales' | 'warehouse' | 'finance';
}

interface ShipmentBatch {
  id: string;
  batch_no: number;
  quantity: number;
  quantity_unit?: string;
  etd?: string;
  actual_ship_date?: string;
  bl_number?: string;
  vessel_name?: string;
  tracking_no?: string;
  notes?: string;
  status: string;
}

interface ShipmentTabProps {
  orderId: string;
  orderQty?: number;
  currentRole: string;
  isAdmin: boolean;
  userId?: string;
  isSplitShipment?: boolean;
}

export function ShipmentTab({ orderId, currentRole, isAdmin, userId, orderQty, isSplitShipment }: ShipmentTabProps) {
  const [conf, setConf] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ shipment_qty: '', order_qty: '', bl_number: '', vessel_name: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 分批出货
  const [batches, setBatches] = useState<ShipmentBatch[]>([]);
  const [showSplitSetup, setShowSplitSetup] = useState(false);
  const [splitRows, setSplitRows] = useState<Array<{ quantity: string; etd: string; notes: string }>>([
    { quantity: '', etd: '', notes: '' },
    { quantity: '', etd: '', notes: '' },
  ]);
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState('');
  const [editingBatch, setEditingBatch] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      getShipmentConfirmation(orderId),
      getShipmentBatches(orderId),
    ]).then(([confRes, batchRes]) => {
      setConf(confRes.data || null);
      setBatches(batchRes.data || []);
      setLoading(false);
    });
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  const canSign = (field: string): boolean => {
    if (!conf || conf['status'] === 'locked' || conf['status'] === 'fully_signed' || conf[field]) return false;
    if (field === 'sales_sign_id') return currentRole === 'sales' || isAdmin;
    if (field === 'warehouse_sign_id') return currentRole === 'logistics' || isAdmin;
    if (field === 'finance_sign_id') return currentRole === 'finance' || isAdmin;
    return false;
  };

  const handleSign = async (signRole: 'sales' | 'warehouse' | 'finance') => {
    if (!conf) return;
    setSigning(true);
    await signShipment(conf['id'] as string, orderId, signRole);
    load();
    setSigning(false);
  };

  async function handleCreate() {
    setSaving(true); setError('');
    const result = await createShipmentConfirmation(orderId, {
      shipment_qty: parseInt(createForm.shipment_qty) || 0,
      order_qty: createForm.order_qty ? parseInt(createForm.order_qty) : undefined,
      bl_number: createForm.bl_number || undefined,
      vessel_name: createForm.vessel_name || undefined,
    });
    if (result.error) setError(result.error);
    else { setShowCreate(false); load(); }
    setSaving(false);
  }

  // ── 分批出货 ──

  async function handleEnableSplit() {
    setSplitSaving(true);
    setSplitError('');
    const parsed = splitRows
      .filter(r => r.quantity)
      .map(r => ({
        quantity: parseInt(r.quantity) || 0,
        etd: r.etd || undefined,
        notes: r.notes || undefined,
      }));
    if (parsed.length < 2) {
      setSplitError('分批出货至少需要 2 批');
      setSplitSaving(false);
      return;
    }
    const result = await enableSplitShipment(orderId, parsed);
    if (result.error) setSplitError(result.error);
    else { setShowSplitSetup(false); load(); }
    setSplitSaving(false);
  }

  function addSplitRow() {
    setSplitRows(prev => [...prev, { quantity: '', etd: '', notes: '' }]);
  }

  function removeSplitRow(idx: number) {
    setSplitRows(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleBatchUpdate(batchId: string) {
    const updates: Record<string, string> = {};
    if (editForm.status) updates.status = editForm.status;
    if (editForm.actual_ship_date) updates.actual_ship_date = editForm.actual_ship_date;
    if (editForm.bl_number !== undefined) updates.bl_number = editForm.bl_number;
    if (editForm.tracking_no !== undefined) updates.tracking_no = editForm.tracking_no;
    const result = await updateShipmentBatch(batchId, updates);
    if (result.error) alert(result.error);
    else { setEditingBatch(null); load(); }
  }

  const signers: SignerConfig[] = [
    { role: '业务/理单确认', field: 'sales_sign_id', signedAt: 'sales_signed_at', signRole: 'sales' },
    { role: '仓库确认', field: 'warehouse_sign_id', signedAt: 'warehouse_signed_at', signRole: 'warehouse' },
    { role: '财务确认', field: 'finance_sign_id', signedAt: 'finance_signed_at', signRole: 'finance' },
  ];

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  const statusLabel: Record<string, string> = {
    planned: '计划中',
    shipped: '已出货',
    delivered: '已送达',
    cancelled: '已取消',
  };
  const statusColor: Record<string, string> = {
    planned: 'bg-gray-100 text-gray-700',
    shipped: 'bg-blue-100 text-blue-700',
    delivered: 'bg-green-100 text-green-700',
    cancelled: 'bg-red-100 text-red-700',
  };

  return (
    <div className="space-y-8">

      {/* ════ 分批出货管理 ════ */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-gray-900">
            {batches.length > 0 ? `分批出货（${batches.length} 批）` : '出货批次'}
          </h3>
          {batches.length === 0 && (
            <button
              onClick={() => setShowSplitSetup(true)}
              className="text-xs px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 font-medium hover:bg-indigo-100"
            >
              + 设置分批出货
            </button>
          )}
        </div>

        {/* 分批设置表单 */}
        {showSplitSetup && (
          <div className="bg-indigo-50 rounded-xl p-5 space-y-4 mb-4 border border-indigo-200">
            <p className="text-sm font-medium text-indigo-900">设置分批出货计划</p>
            {orderQty && (
              <p className="text-xs text-indigo-600">订单总数量：{orderQty} 件</p>
            )}
            <div className="space-y-2">
              {splitRows.map((row, idx) => (
                <div key={idx} className="flex gap-2 items-center">
                  <span className="text-xs text-gray-500 w-12 shrink-0">第{idx + 1}批</span>
                  <input
                    type="number"
                    placeholder="数量 *"
                    value={row.quantity}
                    onChange={e => setSplitRows(prev => prev.map((r, i) => i === idx ? { ...r, quantity: e.target.value } : r))}
                    className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                  <input
                    type="date"
                    placeholder="预计出货日"
                    value={row.etd}
                    onChange={e => setSplitRows(prev => prev.map((r, i) => i === idx ? { ...r, etd: e.target.value } : r))}
                    className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                  <input
                    type="text"
                    placeholder="备注"
                    value={row.notes}
                    onChange={e => setSplitRows(prev => prev.map((r, i) => i === idx ? { ...r, notes: e.target.value } : r))}
                    className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm"
                  />
                  {splitRows.length > 2 && (
                    <button onClick={() => removeSplitRow(idx)} className="text-red-400 hover:text-red-600 text-sm">x</button>
                  )}
                </div>
              ))}
            </div>
            <button onClick={addSplitRow} className="text-xs text-indigo-600 hover:underline">+ 添加一批</button>
            {splitError && <p className="text-xs text-red-600">{splitError}</p>}
            <div className="flex gap-2">
              <button onClick={handleEnableSplit} disabled={splitSaving}
                className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">
                {splitSaving ? '保存中...' : '确认分批'}
              </button>
              <button onClick={() => setShowSplitSetup(false)}
                className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500">取消</button>
            </div>
          </div>
        )}

        {/* 分批列表 */}
        {batches.length > 0 && (
          <div className="space-y-3">
            {batches.map(batch => (
              <div key={batch.id} className="rounded-xl border border-gray-200 bg-white p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-gray-900">第 {batch.batch_no} 批</span>
                    <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + (statusColor[batch.status] || 'bg-gray-100 text-gray-600')}>
                      {statusLabel[batch.status] || batch.status}
                    </span>
                  </div>
                  {editingBatch !== batch.id && (isAdmin || currentRole === 'sales' || currentRole === 'logistics') && (
                    <button
                      onClick={() => {
                        setEditingBatch(batch.id);
                        setEditForm({
                          status: batch.status,
                          actual_ship_date: batch.actual_ship_date || '',
                          bl_number: batch.bl_number || '',
                          tracking_no: batch.tracking_no || '',
                        });
                      }}
                      className="text-xs text-indigo-600 hover:underline"
                    >
                      更新状态
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
                  <div>
                    <span className="text-xs text-gray-400">数量</span>
                    <p className="font-medium text-gray-900">{batch.quantity} {batch.quantity_unit || '件'}</p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-400">预计出货</span>
                    <p className="font-medium text-gray-900">{batch.etd || '-'}</p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-400">实际出货</span>
                    <p className="font-medium text-gray-900">{batch.actual_ship_date || '-'}</p>
                  </div>
                  <div>
                    <span className="text-xs text-gray-400">提单号/快递单号</span>
                    <p className="font-medium text-gray-900">{batch.bl_number || batch.tracking_no || '-'}</p>
                  </div>
                </div>
                {batch.notes && (
                  <p className="text-xs text-gray-500 mt-2">{batch.notes}</p>
                )}

                {/* 编辑表单 */}
                {editingBatch === batch.id && (
                  <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-gray-500">状态</label>
                        <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))}
                          className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
                          <option value="planned">计划中</option>
                          <option value="shipped">已出货</option>
                          <option value="delivered">已送达</option>
                          <option value="cancelled">已取消</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">实际出货日</label>
                        <input type="date" value={editForm.actual_ship_date} onChange={e => setEditForm(f => ({ ...f, actual_ship_date: e.target.value }))}
                          className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">提单号 / 快递单号</label>
                        <input value={editForm.bl_number} onChange={e => setEditForm(f => ({ ...f, bl_number: e.target.value }))}
                          className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" placeholder="B/L No. / 快递单号" />
                      </div>
                      <div>
                        <label className="text-xs text-gray-500">追踪号</label>
                        <input value={editForm.tracking_no} onChange={e => setEditForm(f => ({ ...f, tracking_no: e.target.value }))}
                          className="w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm" placeholder="Tracking No." />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={() => handleBatchUpdate(batch.id)}
                        className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-medium">保存</button>
                      <button onClick={() => setEditingBatch(null)}
                        className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs text-gray-500">取消</button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* 分批汇总 */}
            <div className="flex items-center gap-4 px-4 py-2 bg-gray-50 rounded-lg text-sm">
              <span className="text-gray-500">合计：</span>
              <span className="font-medium text-gray-900">{batches.reduce((s, b) => s + b.quantity, 0)} 件</span>
              <span className="text-gray-400">|</span>
              <span className="text-gray-500">已出货：</span>
              <span className="font-medium text-green-700">
                {batches.filter(b => b.status === 'shipped' || b.status === 'delivered').reduce((s, b) => s + b.quantity, 0)} 件
              </span>
            </div>
          </div>
        )}
      </div>

      {/* ════ 发货确认 & 三方签核 ════ */}
      {!conf ? (
        <div className="text-center py-8">
          {showCreate ? (
            <div className="max-w-md mx-auto bg-indigo-50 rounded-xl p-5 space-y-3 text-left">
              <h3 className="text-sm font-semibold text-gray-900">创建发货确认</h3>
              <div className="grid grid-cols-2 gap-3">
                <input placeholder="出货数量 *" type="number" value={createForm.shipment_qty} onChange={e => setCreateForm(f => ({ ...f, shipment_qty: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                <input placeholder="订单数量" type="number" value={createForm.order_qty} onChange={e => setCreateForm(f => ({ ...f, order_qty: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                <input placeholder="提单号 (B/L)" value={createForm.bl_number} onChange={e => setCreateForm(f => ({ ...f, bl_number: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                <input placeholder="船名" value={createForm.vessel_name} onChange={e => setCreateForm(f => ({ ...f, vessel_name: e.target.value }))} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              </div>
              {error && <p className="text-xs text-red-600">{error}</p>}
              <div className="flex gap-2">
                <button onClick={handleCreate} disabled={saving || !createForm.shipment_qty} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">创建</button>
                <button onClick={() => setShowCreate(false)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500">取消</button>
              </div>
            </div>
          ) : (
            <div className="text-gray-400">
              <p className="mb-3">暂无出货确认记录</p>
              <button onClick={() => setShowCreate(true)} className="text-sm px-4 py-2 rounded-lg bg-indigo-600 text-white font-medium hover:bg-indigo-700">+ 创建发货确认</button>
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 出货数量对比 */}
          {(() => {
            const shipQty = Number(conf['shipment_qty'] || 0);
            const oQty = Number(conf['order_qty'] || 0);
            const variance = shipQty - oQty;
            const variancePct = oQty > 0 ? Math.round((Math.abs(variance) / oQty) * 100) : 0;
            const varianceText = (variance >= 0 ? '+' : '') + String(variance) + ' (' + String(variancePct) + '%)';
            const varianceColor = variance === 0 ? 'text-green-600' : Math.abs(variancePct) > 5 ? 'text-red-600' : 'text-yellow-600';
            return (
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center p-4 bg-gray-50 rounded-xl">
                  <div className="text-2xl font-bold text-gray-700">{oQty}</div>
                  <div className="text-sm text-gray-400 mt-1">订单数量</div>
                </div>
                <div className="text-center p-4 bg-gray-50 rounded-xl">
                  <div className="text-2xl font-bold text-gray-900">{shipQty}</div>
                  <div className="text-sm text-gray-400 mt-1">出货数量</div>
                </div>
                <div className="text-center p-4 bg-gray-50 rounded-xl">
                  <div className={'text-2xl font-bold ' + varianceColor}>{varianceText}</div>
                  <div className="text-sm text-gray-400 mt-1">差异</div>
                </div>
              </div>
            );
          })()}

          {conf['bl_number'] && (
            <div className="flex gap-4 text-sm text-gray-500">
              {conf['bl_number'] && <span>提单号: <strong className="text-gray-900">{String(conf['bl_number'])}</strong></span>}
              {conf['vessel_name'] && <span>船名: <strong className="text-gray-900">{String(conf['vessel_name'])}</strong></span>}
            </div>
          )}

          {/* 三方签核 */}
          <div>
            <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">三方签核</h3>
            <div className="space-y-3">
              {signers.map((signer) => {
                const signed = !!conf[signer.field];
                const signedTime = conf[signer.signedAt];
                return (
                  <div key={signer.field} className={'flex items-center justify-between p-4 rounded-xl border ' + (signed ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white')}>
                    <div className="flex items-center gap-3">
                      <div className={'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' + (signed ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-400')}>
                        {signed ? '✓' : '?'}
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{signer.role}</p>
                        {signed && signedTime && <p className="text-xs text-gray-400">{new Date(String(signedTime)).toLocaleString('zh-CN')}</p>}
                      </div>
                    </div>
                    {canSign(signer.field) && (
                      <button onClick={() => handleSign(signer.signRole)} disabled={signing}
                        className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                        {signing ? '签核中...' : '我来签核'}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {(conf['status'] === 'fully_signed' || conf['status'] === 'locked') && (
            <div className="p-4 bg-green-50 rounded-xl border border-green-200 text-center">
              <p className="text-green-700 font-medium">三方签核已完成，出货已锁定</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
