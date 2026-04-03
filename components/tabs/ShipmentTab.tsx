'use client';
import { useEffect, useState, useCallback } from 'react';
import { getShipmentConfirmation, createShipmentConfirmation, approveShipment, executeShipment } from '@/app/actions/shipments';
import { getShipmentBatches, enableSplitShipment, updateShipmentBatch } from '@/app/actions/shipment-batches';

interface ShipmentBatch {
  id: string; batch_no: number; quantity: number; quantity_unit?: string;
  etd?: string; actual_ship_date?: string; bl_number?: string; tracking_no?: string; notes?: string; status: string;
}

interface ShipmentTabProps {
  orderId: string;
  orderQty?: number;
  currentRole: string;
  isAdmin: boolean;
  userId?: string;
  isSplitShipment?: boolean;
  orderContext?: { customerName?: string; factoryDate?: string; etd?: string; incoterm?: string };
}

const STEPS = [
  { key: 'qc', label: '验货确认', icon: '🔍', role: '跟单/QC' },
  { key: 'apply', label: '申请出货', icon: '📤', role: '业务' },
  { key: 'finance', label: '财务审批', icon: '💰', role: '财务' },
  { key: 'execute', label: '物流执行', icon: '🚚', role: '物流' },
];

const DELIVERY_METHODS = ['海运', '空运', '快递', '国内送仓', '客户自提'];

export function ShipmentTab({ orderId, currentRole, isAdmin, userId, orderQty, orderContext }: ShipmentTabProps) {
  const [conf, setConf] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // 分批出货
  const [batches, setBatches] = useState<ShipmentBatch[]>([]);
  const [showSplitSetup, setShowSplitSetup] = useState(false);
  const [splitRows, setSplitRows] = useState([{ quantity: '', etd: '', notes: '' }, { quantity: '', etd: '', notes: '' }]);
  const [editingBatch, setEditingBatch] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<Record<string, string>>({});

  // 出货申请表单
  const [applyForm, setApplyForm] = useState({
    shipment_qty: '', customer_name: '', product_name: '',
    delivery_address: '', delivery_method: '', shipping_port: '', destination_port: '',
    ci_number: '', requested_ship_date: '',
  });

  // 财务审批
  const [financeForm, setFinanceForm] = useState({ decision: 'approved' as 'approved' | 'rejected', payment_status: '', note: '' });

  // 物流执行
  const [execForm, setExecForm] = useState({ actual_ship_date: '', bl_number: '', vessel_name: '', container_no: '', logistics_note: '' });

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([getShipmentConfirmation(orderId), getShipmentBatches(orderId)])
      .then(([c, b]) => { setConf(c.data || null); setBatches(b.data || []); setLoading(false); });
  }, [orderId]);

  useEffect(() => { load(); }, [load]);

  // 当前步骤判断
  function getCurrentStep(): number {
    if (!conf) return 0; // 未创建 → Step 1 (QC)
    const s = conf.status;
    if (s === 'pending') return 1;        // 业务待提交
    if (s === 'sales_signed') return 2;   // 财务待审批
    if (s === 'warehouse_signed') return 3; // 物流待执行
    if (s === 'fully_signed' || s === 'locked') return 4; // 已完成
    return 0;
  }

  const currentStep = getCurrentStep();

  // 角色权限
  const canApply = currentRole === 'sales' || isAdmin;
  const canApproveFinance = currentRole === 'finance' || isAdmin;
  const canExecute = currentRole === 'logistics' || isAdmin;

  // 提交出货申请
  async function handleApply() {
    setSaving(true); setError('');
    const qty = parseInt(applyForm.shipment_qty);
    if (!qty || qty <= 0) { setError('出货数量必须大于0'); setSaving(false); return; }
    const result = await createShipmentConfirmation(orderId, {
      shipment_qty: qty, order_qty: orderQty,
      customer_name: applyForm.customer_name || orderContext?.customerName,
      product_name: applyForm.product_name || undefined,
      delivery_address: applyForm.delivery_address || undefined,
      delivery_method: applyForm.delivery_method || undefined,
      shipping_port: applyForm.shipping_port || undefined,
      destination_port: applyForm.destination_port || undefined,
      ci_number: applyForm.ci_number || undefined,
      requested_ship_date: applyForm.requested_ship_date || undefined,
    });
    if (result.error) setError(result.error); else load();
    setSaving(false);
  }

  // 财务审批
  async function handleFinanceApprove() {
    if (!conf) return;
    setSaving(true); setError('');
    const result = await approveShipment(conf.id, orderId, financeForm.decision, financeForm.payment_status, financeForm.note);
    if (result.error) setError(result.error); else load();
    setSaving(false);
  }

  // 物流执行
  async function handleExecute() {
    if (!conf) return;
    setSaving(true); setError('');
    const result = await executeShipment(conf.id, orderId, {
      actual_ship_date: execForm.actual_ship_date || undefined,
      bl_number: execForm.bl_number || undefined,
      vessel_name: execForm.vessel_name || undefined,
      container_no: execForm.container_no || undefined,
      logistics_note: execForm.logistics_note || undefined,
    });
    if (result.error) setError(result.error); else load();
    setSaving(false);
  }

  // 分批出货操作
  async function handleEnableSplit() {
    setSaving(true); setError('');
    const parsed = splitRows.filter(r => r.quantity).map(r => ({ quantity: parseInt(r.quantity) || 0, etd: r.etd || undefined, notes: r.notes || undefined }));
    if (parsed.length < 2) { setError('分批出货至少需要 2 批'); setSaving(false); return; }
    const result = await enableSplitShipment(orderId, parsed);
    if (result.error) setError(result.error); else { setShowSplitSetup(false); load(); }
    setSaving(false);
  }

  async function handleBatchUpdate(batchId: string) {
    const result = await updateShipmentBatch(batchId, editForm);
    if (result.error) alert(result.error); else { setEditingBatch(null); load(); }
  }

  const statusLabel: Record<string, string> = { planned: '计划中', shipped: '已出货', delivered: '已送达', cancelled: '已取消' };
  const statusColor: Record<string, string> = { planned: 'bg-gray-100 text-gray-700', shipped: 'bg-blue-100 text-blue-700', delivered: 'bg-green-100 text-green-700', cancelled: 'bg-red-100 text-red-700' };

  if (loading) return <div className="text-center py-8 text-gray-400">加载中...</div>;

  return (
    <div className="space-y-8">
      {/* ===== 流程步骤条 ===== */}
      <div className="flex items-center gap-1">
        {STEPS.map((step, i) => {
          const done = currentStep > i;
          const active = currentStep === i;
          return (
            <div key={step.key} className="flex items-center flex-1">
              <div className="flex flex-col items-center flex-1">
                <div className={`w-10 h-10 rounded-full flex items-center justify-center text-base font-bold border-2 transition-all ${
                  done ? 'bg-green-500 border-green-500 text-white' : active ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-gray-300 text-gray-400'
                }`}>
                  {done ? '✓' : step.icon}
                </div>
                <div className={`mt-1.5 text-xs text-center font-medium ${done ? 'text-green-700' : active ? 'text-indigo-700' : 'text-gray-400'}`}>
                  {step.label}
                </div>
                <div className="text-xs text-gray-400">{step.role}</div>
              </div>
              {i < STEPS.length - 1 && (
                <div className={`h-0.5 w-full mx-1 ${done ? 'bg-green-500' : 'bg-gray-200'}`} />
              )}
            </div>
          );
        })}
      </div>

      {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}

      {/* ===== Step 1: 验货确认 ===== */}
      {currentStep === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="font-bold text-gray-900 mb-3">🔍 验货确认</h3>
          <p className="text-sm text-gray-600 mb-4">验货/放行节点完成后，业务可申请出货</p>
          <div className="p-4 bg-amber-50 rounded-lg border border-amber-200 text-sm text-amber-800">
            请在「执行进度」中完成验货/放行节点后再申请出货
          </div>
        </div>
      )}

      {/* ===== Step 2: 申请出货（业务） ===== */}
      {currentStep <= 1 && !conf && canApply && (
        <div className="bg-white rounded-xl border border-indigo-200 p-6">
          <h3 className="font-bold text-gray-900 mb-4">📤 申请出货</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">出货数量 <span className="text-red-500">*</span></label>
              <input type="number" value={applyForm.shipment_qty} onChange={e => setApplyForm(f => ({ ...f, shipment_qty: e.target.value }))}
                placeholder={orderQty ? `订单数量: ${orderQty}` : ''} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">客户名称</label>
              <input value={applyForm.customer_name || orderContext?.customerName || ''} onChange={e => setApplyForm(f => ({ ...f, customer_name: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">品名</label>
              <input value={applyForm.product_name} onChange={e => setApplyForm(f => ({ ...f, product_name: e.target.value }))}
                placeholder="产品名称/款号" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">送货方式</label>
              <select value={applyForm.delivery_method} onChange={e => setApplyForm(f => ({ ...f, delivery_method: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">请选择</option>
                {DELIVERY_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className="text-xs font-medium text-gray-600 mb-1 block">送货地址</label>
              <input value={applyForm.delivery_address} onChange={e => setApplyForm(f => ({ ...f, delivery_address: e.target.value }))}
                placeholder="仓库地址 / 港口" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            {(applyForm.delivery_method === '海运' || applyForm.delivery_method === '空运') && (
              <>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">装运港</label>
                  <input value={applyForm.shipping_port} onChange={e => setApplyForm(f => ({ ...f, shipping_port: e.target.value }))}
                    placeholder="如: 深圳蛇口" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">目的港</label>
                  <input value={applyForm.destination_port} onChange={e => setApplyForm(f => ({ ...f, destination_port: e.target.value }))}
                    placeholder="如: Los Angeles" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </>
            )}
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">CI 编号</label>
              <input value={applyForm.ci_number} onChange={e => setApplyForm(f => ({ ...f, ci_number: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600 mb-1 block">预计出货日期</label>
              <input type="date" value={applyForm.requested_ship_date} onChange={e => setApplyForm(f => ({ ...f, requested_ship_date: e.target.value }))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
            </div>
          </div>
          <button onClick={handleApply} disabled={saving} className="mt-4 px-6 py-2.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50">
            {saving ? '提交中...' : '提交出货申请'}
          </button>
        </div>
      )}

      {/* ===== Step 3: 财务审批 ===== */}
      {currentStep === 2 && conf && (
        <div className="bg-white rounded-xl border border-amber-200 p-6">
          <h3 className="font-bold text-gray-900 mb-4">💰 财务审批</h3>
          {/* 出货信息只读展示 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-4 p-4 bg-gray-50 rounded-lg">
            <div><span className="text-gray-500">出货数量：</span><span className="font-medium">{conf.shipment_qty}</span></div>
            <div><span className="text-gray-500">客户：</span><span className="font-medium">{conf.customer_name || '-'}</span></div>
            <div><span className="text-gray-500">品名：</span><span className="font-medium">{conf.product_name || '-'}</span></div>
            <div><span className="text-gray-500">送货方式：</span><span className="font-medium">{conf.delivery_method || '-'}</span></div>
            <div><span className="text-gray-500">送货地址：</span><span className="font-medium">{conf.delivery_address || '-'}</span></div>
            <div><span className="text-gray-500">预计日期：</span><span className="font-medium">{conf.requested_ship_date || '-'}</span></div>
            <div><span className="text-gray-500">CI编号：</span><span className="font-medium">{conf.ci_number || '-'}</span></div>
            {conf.shipping_port && <div><span className="text-gray-500">装运港→目的港：</span><span className="font-medium">{conf.shipping_port} → {conf.destination_port}</span></div>}
          </div>
          {canApproveFinance ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">付款状态</label>
                  <select value={financeForm.payment_status} onChange={e => setFinanceForm(f => ({ ...f, payment_status: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm">
                    <option value="">请选择</option>
                    <option value="已收款">已收款</option>
                    <option value="部分收款">部分收款</option>
                    <option value="信用放行">信用放行</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">审批意见</label>
                  <input value={financeForm.note} onChange={e => setFinanceForm(f => ({ ...f, note: e.target.value }))}
                    placeholder="备注（驳回时必填）" className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setFinanceForm(f => ({ ...f, decision: 'approved' })); handleFinanceApprove(); }}
                  disabled={saving} className="px-6 py-2.5 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700 disabled:opacity-50">
                  {saving ? '处理中...' : '✓ 批准出货'}
                </button>
                <button onClick={() => { setFinanceForm(f => ({ ...f, decision: 'rejected' })); handleFinanceApprove(); }}
                  disabled={saving || !financeForm.note.trim()} className="px-6 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:opacity-50">
                  ✗ 驳回
                </button>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-amber-50 rounded-lg text-sm text-amber-800">等待财务审批中...</div>
          )}
        </div>
      )}

      {/* ===== Step 4: 物流执行 ===== */}
      {currentStep === 3 && conf && (
        <div className="bg-white rounded-xl border border-blue-200 p-6">
          <h3 className="font-bold text-gray-900 mb-4">🚚 物流执行出货</h3>
          {/* 出货信息+财务审批只读 */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm mb-2 p-4 bg-gray-50 rounded-lg">
            <div><span className="text-gray-500">出货数量：</span><span className="font-medium">{conf.shipment_qty}</span></div>
            <div><span className="text-gray-500">客户：</span><span className="font-medium">{conf.customer_name || '-'}</span></div>
            <div><span className="text-gray-500">送货方式：</span><span className="font-medium">{conf.delivery_method || '-'}</span></div>
            <div><span className="text-gray-500">送货地址：</span><span className="font-medium">{conf.delivery_address || '-'}</span></div>
          </div>
          <div className="p-3 bg-green-50 rounded-lg text-sm text-green-800 mb-4">
            ✓ 财务已批准 · 付款状态：{conf.payment_status || '未标注'}
          </div>
          {canExecute ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">实际出货日期</label>
                  <input type="date" value={execForm.actual_ship_date} onChange={e => setExecForm(f => ({ ...f, actual_ship_date: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">提单号 (B/L)</label>
                  <input value={execForm.bl_number} onChange={e => setExecForm(f => ({ ...f, bl_number: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">船名/航次</label>
                  <input value={execForm.vessel_name} onChange={e => setExecForm(f => ({ ...f, vessel_name: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs font-medium text-gray-600 mb-1 block">柜号</label>
                  <input value={execForm.container_no} onChange={e => setExecForm(f => ({ ...f, container_no: e.target.value }))}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
                </div>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600 mb-1 block">物流备注</label>
                <textarea value={execForm.logistics_note} onChange={e => setExecForm(f => ({ ...f, logistics_note: e.target.value }))}
                  rows={2} className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" placeholder="装柜、运输注意事项..." />
              </div>
              <button onClick={handleExecute} disabled={saving} className="px-6 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
                {saving ? '确认中...' : '✓ 确认出货完成'}
              </button>
            </div>
          ) : (
            <div className="p-3 bg-blue-50 rounded-lg text-sm text-blue-800">等待物流确认出货...</div>
          )}
        </div>
      )}

      {/* ===== 已完成 ===== */}
      {currentStep === 4 && conf && (
        <div className="bg-white rounded-xl border border-green-200 p-6">
          <div className="text-center mb-4">
            <div className="text-4xl mb-2">🎉</div>
            <h3 className="font-bold text-green-900 text-lg">出货已完成</h3>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm p-4 bg-green-50 rounded-lg">
            <div><span className="text-gray-500">出货数量：</span><span className="font-medium">{conf.shipment_qty}</span></div>
            <div><span className="text-gray-500">客户：</span><span className="font-medium">{conf.customer_name || '-'}</span></div>
            <div><span className="text-gray-500">送货方式：</span><span className="font-medium">{conf.delivery_method || '-'}</span></div>
            <div><span className="text-gray-500">实际出货：</span><span className="font-medium">{conf.actual_ship_date || '-'}</span></div>
            {conf.bl_number && <div><span className="text-gray-500">提单号：</span><span className="font-medium">{conf.bl_number}</span></div>}
            {conf.vessel_name && <div><span className="text-gray-500">船名：</span><span className="font-medium">{conf.vessel_name}</span></div>}
            {conf.container_no && <div><span className="text-gray-500">柜号：</span><span className="font-medium">{conf.container_no}</span></div>}
            {conf.payment_status && <div><span className="text-gray-500">付款状态：</span><span className="font-medium">{conf.payment_status}</span></div>}
          </div>
          <div className="flex gap-4 mt-3 text-xs text-gray-500">
            {conf.sales_signed_at && <span>业务提交: {new Date(conf.sales_signed_at).toLocaleDateString('zh-CN')}</span>}
            {conf.finance_signed_at && <span>财务审批: {new Date(conf.finance_signed_at).toLocaleDateString('zh-CN')}</span>}
            {conf.warehouse_signed_at && <span>物流确认: {new Date(conf.warehouse_signed_at).toLocaleDateString('zh-CN')}</span>}
          </div>
        </div>
      )}

      {/* ===== 分批出货 ===== */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-gray-900">{batches.length > 0 ? `分批出货（${batches.length} 批）` : '出货批次'}</h3>
          {batches.length === 0 && (
            <button onClick={() => setShowSplitSetup(true)} className="text-xs px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 font-medium hover:bg-indigo-100">+ 设置分批出货</button>
          )}
        </div>
        {showSplitSetup && (
          <div className="bg-indigo-50 rounded-xl p-5 space-y-3 mb-4 border border-indigo-200">
            <p className="text-sm font-medium text-indigo-900">设置分批出货计划</p>
            {splitRows.map((row, idx) => (
              <div key={idx} className="flex gap-2 items-center">
                <span className="text-xs text-gray-500 w-12 shrink-0">第{idx + 1}批</span>
                <input type="number" placeholder="数量 *" value={row.quantity} onChange={e => setSplitRows(prev => prev.map((r, i) => i === idx ? { ...r, quantity: e.target.value } : r))} className="w-24 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                <input type="date" value={row.etd} onChange={e => setSplitRows(prev => prev.map((r, i) => i === idx ? { ...r, etd: e.target.value } : r))} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                <input type="text" placeholder="备注" value={row.notes} onChange={e => setSplitRows(prev => prev.map((r, i) => i === idx ? { ...r, notes: e.target.value } : r))} className="flex-1 rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                {splitRows.length > 2 && <button onClick={() => setSplitRows(prev => prev.filter((_, i) => i !== idx))} className="text-red-400 hover:text-red-600 text-sm">x</button>}
              </div>
            ))}
            <button onClick={() => setSplitRows(prev => [...prev, { quantity: '', etd: '', notes: '' }])} className="text-xs text-indigo-600 hover:underline">+ 添加一批</button>
            <div className="flex gap-2">
              <button onClick={handleEnableSplit} disabled={saving} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-sm font-medium disabled:opacity-50">{saving ? '保存中...' : '确认分批'}</button>
              <button onClick={() => setShowSplitSetup(false)} className="px-4 py-2 rounded-lg border border-gray-200 text-sm text-gray-500">取消</button>
            </div>
          </div>
        )}
        {batches.length > 0 && (
          <div className="space-y-2">
            {batches.map(batch => (
              <div key={batch.id} className="rounded-xl border border-gray-200 bg-white p-3">
                <div className="flex items-center justify-between mb-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-bold text-gray-900">第 {batch.batch_no} 批</span>
                    <span className={'text-xs px-2 py-0.5 rounded-full font-medium ' + (statusColor[batch.status] || 'bg-gray-100')}>{statusLabel[batch.status] || batch.status}</span>
                  </div>
                  {editingBatch !== batch.id && (isAdmin || currentRole === 'sales' || currentRole === 'logistics') && (
                    <button onClick={() => { setEditingBatch(batch.id); setEditForm({ status: batch.status, actual_ship_date: batch.actual_ship_date || '', bl_number: batch.bl_number || '', tracking_no: batch.tracking_no || '' }); }} className="text-xs text-indigo-600 hover:underline">更新</button>
                  )}
                </div>
                <div className="grid grid-cols-4 gap-2 text-sm">
                  <div><span className="text-xs text-gray-400">数量</span><p className="font-medium">{batch.quantity}</p></div>
                  <div><span className="text-xs text-gray-400">预计</span><p className="font-medium">{batch.etd || '-'}</p></div>
                  <div><span className="text-xs text-gray-400">实际</span><p className="font-medium">{batch.actual_ship_date || '-'}</p></div>
                  <div><span className="text-xs text-gray-400">单号</span><p className="font-medium">{batch.bl_number || batch.tracking_no || '-'}</p></div>
                </div>
                {editingBatch === batch.id && (
                  <div className="mt-2 pt-2 border-t border-gray-100 grid grid-cols-2 gap-2">
                    <select value={editForm.status} onChange={e => setEditForm(f => ({ ...f, status: e.target.value }))} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm">
                      <option value="planned">计划中</option><option value="shipped">已出货</option><option value="delivered">已送达</option><option value="cancelled">已取消</option>
                    </select>
                    <input type="date" value={editForm.actual_ship_date} onChange={e => setEditForm(f => ({ ...f, actual_ship_date: e.target.value }))} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                    <input value={editForm.bl_number} onChange={e => setEditForm(f => ({ ...f, bl_number: e.target.value }))} placeholder="提单号" className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm" />
                    <div className="flex gap-1">
                      <button onClick={() => handleBatchUpdate(batch.id)} className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs">保存</button>
                      <button onClick={() => setEditingBatch(null)} className="px-3 py-1.5 rounded-lg border border-gray-200 text-xs">取消</button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
