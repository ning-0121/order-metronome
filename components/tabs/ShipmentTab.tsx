'use client';
import { useEffect, useState, useCallback } from 'react';
import { createClient } from '@/lib/supabase/client';

interface SignerConfig {
  role: string;
  field: string;
  signedAt: string;
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

  const load = useCallback(() => {
    createClient()
      .from('shipment_confirmations')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data }) => {
        setConf((data && data[0]) ? data[0] as Record<string, unknown> : null);
        setLoading(false);
      });
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  const canSign = (field: string): boolean => {
    if (!conf || conf['status'] === 'locked' || conf[field]) return false;
    if (field === 'sales_sign_id') return currentRole === 'sales' || isAdmin;
    if (field === 'warehouse_sign_id') return currentRole === 'logistics' || isAdmin;
    if (field === 'finance_sign_id') return currentRole === 'finance' || isAdmin;
    return false;
  };

  const handleSign = async (field: string) => {
    if (!conf || !userId) return;
    setSigning(true);
    const atField = field.replace('_sign_id', '_signed_at');
    await createClient()
      .from('shipment_confirmations')
      .update({ [field]: userId, [atField]: new Date().toISOString() })
      .eq('id', conf['id'] as string);
    load();
    setSigning(false);
  };

  const signers: SignerConfig[] = [
    { role: '业务确认', field: 'sales_sign_id', signedAt: 'sales_signed_at' },
    { role: '仓库确认', field: 'warehouse_sign_id', signedAt: 'warehouse_signed_at' },
    { role: '财务确认', field: 'finance_sign_id', signedAt: 'finance_signed_at' },
  ];

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  if (!conf) {
    return (
      <div className="text-center py-12 text-gray-400">
        <p className="mb-2">暂无出货确认记录</p>
        <p className="text-sm">装箱确认后，由业务创建出货确认单</p>
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

      {variance !== 0 && conf['variance_reason'] && (
        <div className="p-4 bg-yellow-50 rounded-xl border border-yellow-200">
          <p className="text-sm font-medium text-yellow-700">差异原因：{String(conf['variance_reason'])}</p>
        </div>
      )}

      <div>
        <h3 className="text-sm font-medium text-gray-500 uppercase tracking-wide mb-4">三方签核</h3>
        <div className="space-y-3">
          {signers.map((signer) => {
            const signed = !!conf[signer.field];
            const signedTime = conf[signer.signedAt];
            const cardClass = 'flex items-center justify-between p-4 rounded-xl border ' +
              (signed ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-white');
            const dotClass = 'w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ' +
              (signed ? 'bg-green-500 text-white' : 'bg-gray-200 text-gray-400');
            return (
              <div key={signer.field} className={cardClass}>
                <div className="flex items-center gap-3">
                  <div className={dotClass}>{signed ? '✓' : '?'}</div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{signer.role}</p>
                    {signed && signedTime && (
                      <p className="text-xs text-gray-400">
                        {new Date(String(signedTime)).toLocaleString('zh-CN')}
                      </p>
                    )}
                  </div>
                </div>
                {canSign(signer.field) && (
                  <button
                    onClick={() => handleSign(signer.field)}
                    disabled={signing}
                    className="px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {signing ? '签核中...' : '我来签核'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {conf['status'] === 'fully_signed' && (
        <div className="p-4 bg-green-50 rounded-xl border border-green-200 text-center">
          <p className="text-green-700 font-medium">三方签核已完成，出货已锁定</p>
        </div>
      )}
    </div>
  );
}
