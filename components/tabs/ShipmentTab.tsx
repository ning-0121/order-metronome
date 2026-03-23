'use client';
import { useEffect, useState, useCallback } from 'react';
import { getShipmentConfirmation, createShipmentConfirmation, signShipment } from '@/app/actions/shipments';

interface SignerConfig {
  role: string;
  field: string;
  signedAt: string;
  signRole: 'sales' | 'warehouse' | 'finance';
}

interface ShipmentTabProps {
  orderId: string;
  orderQty?: number;
  currentRole: string;
  isAdmin: boolean;
  userId?: string;
}

export function ShipmentTab({ orderId, currentRole, isAdmin, userId }: ShipmentTabProps) {
  const [conf, setConf] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(true);
  const [signing, setSigning] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ shipment_qty: '', order_qty: '', bl_number: '', vessel_name: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    getShipmentConfirmation(orderId).then(({ data }) => {
      setConf(data || null);
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

  const signers: SignerConfig[] = [
    { role: '理单确认', field: 'sales_sign_id', signedAt: 'sales_signed_at', signRole: 'sales' },
    { role: '仓库确认', field: 'warehouse_sign_id', signedAt: 'warehouse_signed_at', signRole: 'warehouse' },
    { role: '财务确认', field: 'finance_sign_id', signedAt: 'finance_signed_at', signRole: 'finance' },
  ];

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  if (!conf) {
    return (
      <div className="text-center py-12">
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
    );
  }

  const shipQty = Number(conf['shipment_qty'] || 0);
  const orderQty = Number(conf['order_qty'] || 0);
  const variance = shipQty - orderQty;
  const variancePct = orderQty > 0 ? Math.round((Math.abs(variance) / orderQty) * 100) : 0;
  const varianceText = (variance >= 0 ? '+' : '') + String(variance) + ' (' + String(variancePct) + '%)';
  const varianceColor = variance === 0 ? 'text-green-600' : Math.abs(variancePct) > 5 ? 'text-red-600' : 'text-yellow-600';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-3 gap-4">
        <div className="text-center p-4 bg-gray-50 rounded-xl">
          <div className="text-2xl font-bold text-gray-700">{orderQty}</div>
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

      {conf['bl_number'] && (
        <div className="flex gap-4 text-sm text-gray-500">
          {conf['bl_number'] && <span>提单号: <strong className="text-gray-900">{String(conf['bl_number'])}</strong></span>}
          {conf['vessel_name'] && <span>船名: <strong className="text-gray-900">{String(conf['vessel_name'])}</strong></span>}
        </div>
      )}

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
    </div>
  );
}
