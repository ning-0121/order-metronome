import Link from 'next/link';
import { formatDate } from '@/lib/utils/date';

/**
 * CEO「客户事项分级」面板（Phase 1：只读展示 customer_matters 物化结果）。
 * 数据由 /api/admin/customer-matters-materialize 手动物化（dry_run 人审后 execute）。
 * 投诉类一律展示为「疑似投诉/质量邮件」，evidence 摘要可见，由 CEO 自行判断真伪。
 */

interface Matter {
  id: string;
  customer_name: string;
  order_id: string | null;
  order_no: string | null;
  matter_type: 'suspected_complaint' | 'delivery_risk' | 'overdue';
  severity: 'high' | 'medium';
  title: string;
  evidence: Record<string, any> | null;
  detected_at: string;
  materialized_at: string;
}

const TYPE_META: Record<Matter['matter_type'], { icon: string; label: string }> = {
  suspected_complaint: { icon: '📧', label: '疑似投诉' },
  delivery_risk: { icon: '🟠', label: '交期风险' },
  overdue: { icon: '⏰', label: '节点逾期' },
};

function evidenceLine(m: Matter): string {
  const ev = m.evidence || {};
  if (m.matter_type === 'suspected_complaint') {
    const kw = Array.isArray(ev.matched_keywords) ? ev.matched_keywords.join(', ') : '';
    return `@${ev.from_domain || '?'} · ${ev.received_at ? formatDate(ev.received_at) : ''} · 命中: ${kw}`;
  }
  if (m.matter_type === 'delivery_risk') {
    return ev.headline ? String(ev.headline) : `置信度 ${ev.delivery_confidence ?? '?'}%（${ev.risk_level ?? '?'}）`;
  }
  return `截止 ${ev.due_at ? formatDate(ev.due_at) : '?'} · 已逾期 ${ev.overdue_days ?? '?'} 天`;
}

export function CustomerMattersPanel({ matters, loadError }: { matters: Matter[]; loadError?: boolean }) {
  // 按客户分组，组内 high 在前；客户按（高项数, 总数）倒序
  const byCustomer = new Map<string, Matter[]>();
  for (const m of matters) {
    const list = byCustomer.get(m.customer_name) || [];
    list.push(m);
    byCustomer.set(m.customer_name, list);
  }
  const customers = [...byCustomer.entries()]
    .map(([name, list]) => ({
      name,
      list: [...list].sort((a, b) =>
        a.severity === b.severity
          ? b.detected_at.localeCompare(a.detected_at)
          : a.severity === 'high' ? -1 : 1),
      high: list.filter(x => x.severity === 'high').length,
      medium: list.filter(x => x.severity === 'medium').length,
    }))
    .sort((a, b) => (b.high - a.high) || (b.list.length - a.list.length));

  const latestMaterialized = matters.reduce(
    (max, m) => (m.materialized_at > max ? m.materialized_at : max), '');

  return (
    <div className="bg-white rounded-xl border border-sky-200 shadow-sm overflow-hidden">
      <div className="bg-sky-50 px-5 py-3 border-b border-sky-100 flex items-center justify-between">
        <h2 className="text-lg font-bold text-sky-900">📨 客户事项分级（{matters.length} 项）</h2>
        {latestMaterialized && (
          <span className="text-xs text-gray-500">最近物化：{formatDate(latestMaterialized)}</span>
        )}
      </div>

      {loadError ? (
        <div className="p-4 text-center text-gray-400 text-sm">客户事项加载失败（可能尚未建表），详见服务端日志</div>
      ) : customers.length === 0 ? (
        <div className="p-4 text-center text-gray-400 text-sm">暂无数据（尚未物化，或当前无高/中级事项）</div>
      ) : (
        <div className="divide-y divide-gray-100">
          {customers.map(c => (
            <details key={c.name} className="group" open={c.high > 0}>
              <summary className="px-5 py-3 flex items-center justify-between cursor-pointer hover:bg-sky-50/50 select-none">
                <span className="font-bold text-gray-900">{c.name}</span>
                <span className="flex items-center gap-2 text-xs">
                  {c.high > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-semibold">🔴 高×{c.high}</span>
                  )}
                  {c.medium > 0 && (
                    <span className="px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-700 font-semibold">🟡 中×{c.medium}</span>
                  )}
                </span>
              </summary>
              <div className="px-5 pb-3 space-y-2">
                {c.list.map(m => {
                  const meta = TYPE_META[m.matter_type];
                  return (
                    <div key={m.id}
                      className={`rounded-lg border px-3 py-2 text-sm ${
                        m.severity === 'high' ? 'border-red-200 bg-red-50/50' : 'border-yellow-200 bg-yellow-50/40'
                      }`}>
                      <div className="flex items-start justify-between gap-2">
                        <span className="text-gray-900">
                          <span className="text-xs font-semibold text-gray-500 mr-1.5">{meta.icon} [{meta.label}]</span>
                          {m.order_id && m.order_no ? (
                            <Link href={`/orders/${m.order_id}`} className="font-medium text-indigo-600 hover:underline mr-1">
                              {m.order_no}
                            </Link>
                          ) : null}
                          {m.title}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5 ml-1">↳ {evidenceLine(m)}</p>
                    </div>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
