'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';

export function RetrospectiveAISummary({ orderId, orderNo, customerName }: {
  orderId: string; orderNo: string; customerName: string;
}) {
  const [summary, setSummary] = useState<{
    totalDays: number; overdueDays: number; blockedCount: number;
    delayCount: number; onTime: boolean; highlights: string[];
  } | null>(null);

  useEffect(() => {
    const supabase = createClient();
    Promise.all([
      (supabase.from('milestones') as any).select('name, status, due_at, actual_at, completed_at, started_at').eq('order_id', orderId),
      (supabase.from('delay_requests') as any).select('reason_type, reason_detail, status').eq('order_id', orderId),
      (supabase.from('milestone_logs') as any).select('action, note, created_at').eq('order_id', orderId).eq('action', 'mark_blocked'),
    ]).then(([msRes, delayRes, blockRes]) => {
      const milestones = msRes.data || [];
      const delays = delayRes.data || [];
      const blocks = blockRes.data || [];

      // 计算关键指标
      const completed = milestones.filter((m: any) => m.completed_at);
      let totalOverdueDays = 0;
      let overdueNodes = 0;
      for (const m of completed) {
        if (m.due_at && m.completed_at && new Date(m.completed_at) > new Date(m.due_at)) {
          const diff = Math.ceil((new Date(m.completed_at).getTime() - new Date(m.due_at).getTime()) / 86400000);
          totalOverdueDays += diff;
          overdueNodes++;
        }
      }

      const first = milestones.find((m: any) => m.started_at);
      const last = completed.sort((a: any, b: any) => (b.completed_at || '').localeCompare(a.completed_at || ''))[0];
      const totalDays = first?.started_at && last?.completed_at
        ? Math.ceil((new Date(last.completed_at).getTime() - new Date(first.started_at).getTime()) / 86400000)
        : 0;

      const highlights: string[] = [];
      if (overdueNodes === 0) highlights.push('所有节点按时完成，执行力优秀');
      else highlights.push(`${overdueNodes} 个节点超期，共超 ${totalOverdueDays} 天`);
      if (blocks.length > 0) highlights.push(`${blocks.length} 次节点阻塞`);
      if (delays.length > 0) {
        const reasons = delays.map((d: any) => d.reason_type).filter(Boolean);
        const topReason = reasons.sort((a: string, b: string) => reasons.filter((r: string) => r === b).length - reasons.filter((r: string) => r === a).length)[0];
        const reasonLabels: Record<string, string> = { customer_confirmation: '客户确认', supplier_delay: '供应商延迟', internal_delay: '内部延迟', logistics: '物流', force_majeure: '不可抗力' };
        highlights.push(`${delays.length} 次延期申请，主因：${reasonLabels[topReason] || topReason || '其他'}`);
      }
      if (delays.length === 0 && blocks.length === 0) highlights.push('无延期、无阻塞，流程顺畅');

      setSummary({
        totalDays,
        overdueDays: totalOverdueDays,
        blockedCount: blocks.length,
        delayCount: delays.length,
        onTime: overdueNodes === 0,
        highlights,
      });
    });
  }, [orderId]);

  if (!summary) return null;

  return (
    <div className="bg-indigo-50 rounded-xl border border-indigo-200 p-5">
      <h3 className="font-bold text-indigo-900 mb-3">🤖 AI 复盘摘要</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <div className="text-center p-2 bg-white rounded-lg">
          <div className="text-xl font-bold text-gray-900">{summary.totalDays}</div>
          <div className="text-xs text-gray-500">总周期（天）</div>
        </div>
        <div className="text-center p-2 bg-white rounded-lg">
          <div className={`text-xl font-bold ${summary.overdueDays > 0 ? 'text-red-600' : 'text-green-600'}`}>{summary.overdueDays}</div>
          <div className="text-xs text-gray-500">超期天数</div>
        </div>
        <div className="text-center p-2 bg-white rounded-lg">
          <div className="text-xl font-bold text-orange-600">{summary.blockedCount}</div>
          <div className="text-xs text-gray-500">阻塞次数</div>
        </div>
        <div className="text-center p-2 bg-white rounded-lg">
          <div className="text-xl font-bold text-amber-600">{summary.delayCount}</div>
          <div className="text-xs text-gray-500">延期申请</div>
        </div>
      </div>
      <div className="space-y-1">
        {summary.highlights.map((h, i) => (
          <p key={i} className="text-sm text-indigo-800">• {h}</p>
        ))}
      </div>
    </div>
  );
}
