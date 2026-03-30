'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getOrder, getRetrospective, submitRetrospectiveAction } from '@/app/actions/orders';
import { formatDate } from '@/lib/utils/date';

export default function RetrospectivePage({ params }: { params: { id: string } }) {
  const router = useRouter();
  const [order, setOrder] = useState<any>(null);
  const [retrospective, setRetrospective] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 表单状态
  const [onTimeDelivery, setOnTimeDelivery] = useState<boolean | null>(null);
  const [majorDelayReason, setMajorDelayReason] = useState('');
  const [keyIssue, setKeyIssue] = useState('');
  const [rootCause, setRootCause] = useState('');
  const [whatWorked, setWhatWorked] = useState('');
  const [improvementActions, setImprovementActions] = useState<Array<{
    action: string;
    owner_role: string;
    due_at: string | null;
    success_metric: string | null;
  }>>([{ action: '', owner_role: '', due_at: null, success_metric: null }]);

  useEffect(() => {
    async function loadData() {
      const orderResult = await getOrder(params.id);
      const retroResult = await getRetrospective(params.id);

      if (orderResult.error || !orderResult.data) {
        setError(orderResult.error || '订单不存在');
        setLoading(false);
        return;
      }

      setOrder((orderResult as any).data);

      if (retroResult.data) {
        const retroData = (retroResult as any).data;
        setRetrospective(retroData);
        // 填充已有数据
        setOnTimeDelivery(retroData.on_time_delivery);
        setMajorDelayReason(retroData.major_delay_reason || '');
        setKeyIssue(retroData.key_issue);
        setRootCause(retroData.root_cause);
        setWhatWorked(retroData.what_worked);
        
        try {
          const actions = typeof retroData.improvement_actions === 'string'
            ? JSON.parse(retroData.improvement_actions)
            : retroData.improvement_actions;
          setImprovementActions(actions.length > 0 ? actions : [{ action: '', owner_role: '', due_at: null, success_metric: null }]);
        } catch {
          setImprovementActions([{ action: '', owner_role: '', due_at: null, success_metric: null }]);
        }
      }

      setLoading(false);
    }

    loadData();
  }, [params.id]);

  const addImprovementAction = () => {
    setImprovementActions([
      ...improvementActions,
      { action: '', owner_role: '', due_at: null, success_metric: null },
    ]);
  };

  const removeImprovementAction = (index: number) => {
    if (improvementActions.length > 1) {
      setImprovementActions(improvementActions.filter((_, i) => i !== index));
    }
  };

  const updateImprovementAction = (
    index: number,
    field: string,
    value: string | null
  ) => {
    const updated = [...improvementActions];
    (updated[index] as any)[field] = value;
    setImprovementActions(updated);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // 验证必填字段
    if (!keyIssue.trim()) {
      setError('关键问题为必填项');
      return;
    }
    if (!rootCause.trim()) {
      setError('根本原因为必填项');
      return;
    }
    if (!whatWorked.trim()) {
      setError('做得好的地方为必填项');
      return;
    }

    // 验证改进措施
    const validActions = improvementActions.filter(
      (a) => a.action.trim() && a.owner_role
    );
    if (validActions.length === 0) {
      setError('至少需要添加一条改进措施');
      return;
    }

    setSubmitting(true);

    const formData = new FormData();
    formData.append('on_time_delivery', onTimeDelivery === null ? '' : String(onTimeDelivery));
    formData.append('major_delay_reason', majorDelayReason);
    formData.append('key_issue', keyIssue);
    formData.append('root_cause', rootCause);
    formData.append('what_worked', whatWorked);
    formData.append('improvement_actions', JSON.stringify(validActions));

    const result = await submitRetrospectiveAction(params.id, formData);

    if (result.error) {
      setError(result.error);
      setSubmitting(false);
    } else {
      router.push(`/orders/${params.id}`);
      router.refresh();
    }
  };

  if (loading) {
    return <div className="p-6">加载中...</div>;
  }

  if (error && !order) {
    return <div className="p-6 text-red-600">{error}</div>;
  }

  const orderData = order as any;
  const needsRetrospective = orderData.retrospective_required && !orderData.retrospective_completed_at;
  const isRetrospectiveCompleted = orderData.retrospective_completed_at;

  if (!needsRetrospective && !isRetrospectiveCompleted) {
    return (
      <div className="p-6">
        <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <p className="text-yellow-800">
            该订单不需要复盘或已完成复盘。
          </p>
          <button
            onClick={() => router.push(`/orders/${params.id}`)}
            className="mt-4 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            返回订单详情
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">订单复盘</h1>
        <p className="text-gray-600 mt-2">
          订单号: {orderData.order_no} | 客户: {orderData.customer_name}
        </p>
      </div>

      {isRetrospectiveCompleted && retrospective && (
        <div className="bg-green-50 border border-green-200 rounded-lg p-4">
          <p className="text-green-800 font-medium">
            ✅ 该订单已完成复盘
          </p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* 准时交付 */}
        <div>
          <label className="block text-sm font-medium mb-2">
            是否准时交付
          </label>
          <div className="flex gap-4">
            <label className="flex items-center">
              <input
                type="radio"
                name="on_time_delivery"
                value="true"
                checked={onTimeDelivery === true}
                onChange={() => setOnTimeDelivery(true)}
                className="mr-2"
              />
              是
            </label>
            <label className="flex items-center">
              <input
                type="radio"
                name="on_time_delivery"
                value="false"
                checked={onTimeDelivery === false}
                onChange={() => setOnTimeDelivery(false)}
                className="mr-2"
              />
              否
            </label>
            <label className="flex items-center">
              <input
                type="radio"
                name="on_time_delivery"
                value=""
                checked={onTimeDelivery === null}
                onChange={() => setOnTimeDelivery(null)}
                className="mr-2"
              />
              不适用
            </label>
          </div>
        </div>

        {/* 主要延迟原因 */}
        {onTimeDelivery === false && (
          <div>
            <label className="block text-sm font-medium mb-2">
              主要延迟原因
            </label>
            <select
              value={majorDelayReason}
              onChange={(e) => setMajorDelayReason(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            >
              <option value="">请选择</option>
              <option value="customer">客户原因</option>
              <option value="supplier">供应商原因</option>
              <option value="internal">内部原因</option>
              <option value="logistics">物流原因</option>
              <option value="other">其他</option>
            </select>
          </div>
        )}

        {/* 关键问题 */}
        <div>
          <label className="block text-sm font-medium mb-2">
            关键问题 <span className="text-red-500">*</span>
          </label>
          <textarea
            value={keyIssue}
            onChange={(e) => setKeyIssue(e.target.value)}
            rows={4}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            placeholder="描述订单执行过程中遇到的关键问题..."
          />
        </div>

        {/* 根本原因 */}
        <div>
          <label className="block text-sm font-medium mb-2">
            根本原因 <span className="text-red-500">*</span>
          </label>
          <textarea
            value={rootCause}
            onChange={(e) => setRootCause(e.target.value)}
            rows={4}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            placeholder="分析导致问题的根本原因..."
          />
        </div>

        {/* 做得好的地方 */}
        <div>
          <label className="block text-sm font-medium mb-2">
            做得好的地方 <span className="text-red-500">*</span>
          </label>
          <textarea
            value={whatWorked}
            onChange={(e) => setWhatWorked(e.target.value)}
            rows={4}
            required
            className="w-full px-3 py-2 border border-gray-300 rounded-lg"
            placeholder="总结订单执行过程中做得好的方面..."
          />
        </div>

        {/* 改进措施 */}
        <div>
          <label className="block text-sm font-medium mb-2">
            改进措施 <span className="text-red-500">*</span>
          </label>
          <p className="text-sm text-gray-600 mb-3">
            至少需要添加一条改进措施
          </p>
          {improvementActions.map((action, index) => (
            <div key={index} className="mb-4 p-4 border border-gray-200 rounded-lg">
              <div className="flex justify-between items-center mb-3">
                <span className="font-medium">措施 #{index + 1}</span>
                {improvementActions.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeImprovementAction(index)}
                    className="text-red-600 hover:text-red-700 text-sm"
                  >
                    删除
                  </button>
                )}
              </div>
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1">改进措施</label>
                  <textarea
                    value={action.action}
                    onChange={(e) => updateImprovementAction(index, 'action', e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    placeholder="描述具体的改进措施..."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">负责人角色</label>
                    <select
                      value={action.owner_role}
                      onChange={(e) => updateImprovementAction(index, 'owner_role', e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    >
                      <option value="">请选择</option>
                      <option value="sales">销售</option>
                      <option value="finance">财务</option>
                      <option value="procurement">采购</option>
                      <option value="production">生产</option>
                      <option value="qc">质检</option>
                      <option value="logistics">物流</option>
                      <option value="admin">管理员</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">截止日期（可选）</label>
                    <input
                      type="date"
                      value={action.due_at || ''}
                      onChange={(e) => updateImprovementAction(index, 'due_at', e.target.value || null)}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">成功指标（可选）</label>
                  <input
                    type="text"
                    value={action.success_metric || ''}
                    onChange={(e) => updateImprovementAction(index, 'success_metric', e.target.value || null)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                    placeholder="如何衡量改进措施是否成功..."
                  />
                </div>
              </div>
            </div>
          ))}
          <button
            type="button"
            onClick={addImprovementAction}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
          >
            + 添加改进措施
          </button>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <p className="text-red-800">{error}</p>
          </div>
        )}

        <div className="flex gap-4">
          <button
            type="submit"
            disabled={submitting || isRetrospectiveCompleted}
            className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {submitting ? '提交中...' : isRetrospectiveCompleted ? '已提交' : '提交复盘'}
          </button>
          <button
            type="button"
            onClick={() => router.push(`/orders/${params.id}`)}
            className="px-6 py-3 bg-gray-200 text-gray-700 rounded-lg hover:bg-gray-300 transition-colors"
          >
            返回订单详情
          </button>
        </div>
      </form>
    </div>
  );
}
