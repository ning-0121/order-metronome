import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import Link from 'next/link';

interface AuditIssue {
  severity: 'high' | 'medium' | 'low';
  order_no: string;
  order_id: string;
  customer?: string;
  sales?: string;
  merchandiser?: string;
  issue: string;
  action: string;
}

interface AuditPayload {
  scanned_at?: string;
  total_scanned: number;
  total_issues: number;
  high_count: number;
  medium_count: number;
  issues: AuditIssue[];
}

export default async function AuditReportPage({
  searchParams,
}: {
  searchParams: Promise<{ nid?: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // 仅 admin 可看完整审计（管理员系列功能统一规约）
  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) redirect('/dashboard');

  const params = await searchParams;
  const nid = params?.nid;

  // 找指定通知；找不到时降级为"最近一次 daily_audit"
  let notification: any = null;
  if (nid) {
    const { data } = await (supabase.from('notifications') as any)
      .select('id, type, title, message, payload, created_at, status')
      .eq('id', nid)
      .eq('user_id', user.id)
      .maybeSingle();
    notification = data;
  }
  if (!notification) {
    const { data } = await (supabase.from('notifications') as any)
      .select('id, type, title, message, payload, created_at, status')
      .eq('user_id', user.id)
      .eq('type', 'daily_audit')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    notification = data;
  }

  if (!notification) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">每日订单审计</h1>
        <div className="bg-white rounded-2xl border border-gray-200 p-8 text-center text-gray-500">
          暂无审计记录。每日早上 8:30 自动扫描。
        </div>
      </div>
    );
  }

  const payload: AuditPayload | null = notification.payload || null;

  // payload 为空表示是老版本通知（修复前），只能显示标题/正文
  if (!payload || !payload.issues) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">每日订单审计</h1>
        <p className="text-sm text-gray-500 mb-6">{new Date(notification.created_at).toLocaleString('zh-CN')}</p>

        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 mb-6 text-sm text-amber-800">
          ⚠️ 这是修复前生成的旧通知，没有保留详细问题清单。等下一次每日审计跑完（明早 8:30），点击新通知就能看到完整列表了。
        </div>

        <div className="bg-white rounded-2xl border border-gray-200 p-6">
          <h2 className="font-semibold text-gray-900 mb-2">{notification.title}</h2>
          <pre className="text-sm text-gray-700 whitespace-pre-wrap font-sans">{notification.message}</pre>
        </div>
      </div>
    );
  }

  const high = payload.issues.filter((i) => i.severity === 'high');
  const medium = payload.issues.filter((i) => i.severity === 'medium');
  const low = payload.issues.filter((i) => i.severity === 'low');

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 lg:px-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">📋 每日订单审计</h1>
        <p className="text-sm text-gray-500 mt-1">
          扫描时间：{new Date(payload.scanned_at || notification.created_at).toLocaleString('zh-CN')}
          {' · '}
          共扫描 <span className="font-medium text-gray-700">{payload.total_scanned}</span> 个进行中订单
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <div className="bg-red-50 border border-red-200 rounded-xl p-4">
          <div className="text-xs text-red-700 font-medium">🔴 严重问题</div>
          <div className="text-2xl font-bold text-red-900 mt-1">{payload.high_count}</div>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
          <div className="text-xs text-amber-700 font-medium">🟡 需关注</div>
          <div className="text-2xl font-bold text-amber-900 mt-1">{payload.medium_count}</div>
        </div>
        <div className="bg-gray-50 border border-gray-200 rounded-xl p-4">
          <div className="text-xs text-gray-600 font-medium">总问题数</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{payload.total_issues}</div>
        </div>
      </div>

      {/* Issue list grouped by severity */}
      <IssueGroup title="🔴 严重问题（需立即处理）" badgeClass="bg-red-100 text-red-800" issues={high} />
      <IssueGroup title="🟡 需关注（本周内处理）" badgeClass="bg-amber-100 text-amber-800" issues={medium} />
      {low.length > 0 && (
        <IssueGroup title="🟢 一般提醒" badgeClass="bg-gray-100 text-gray-700" issues={low} />
      )}

      <div className="mt-8 text-xs text-gray-400 text-center">
        审计逻辑：缺内部单号 / 缺工厂 / 缺跟单 / 数量为 0 / 出厂日过期 / 14 天未更新 / 多节点逾期
      </div>
    </div>
  );
}

function IssueGroup({ title, badgeClass, issues }: { title: string; badgeClass: string; issues: AuditIssue[] }) {
  if (issues.length === 0) return null;

  // 同一订单的多个问题合并展示
  const grouped = new Map<string, { order_no: string; order_id: string; customer?: string; sales?: string; merchandiser?: string; items: AuditIssue[] }>();
  for (const issue of issues) {
    const key = issue.order_id || issue.order_no;
    if (!grouped.has(key)) {
      grouped.set(key, {
        order_no: issue.order_no,
        order_id: issue.order_id,
        customer: issue.customer,
        sales: issue.sales,
        merchandiser: issue.merchandiser,
        items: [],
      });
    }
    grouped.get(key)!.items.push(issue);
  }

  return (
    <div className="mb-6">
      <h2 className="text-sm font-semibold text-gray-900 mb-3">
        {title} <span className="text-gray-400 font-normal">({issues.length})</span>
      </h2>
      <div className="space-y-2">
        {Array.from(grouped.values()).map((group) => (
          <div key={group.order_id || group.order_no} className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="px-4 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                {group.order_id ? (
                  <Link href={`/orders/${group.order_id}?tab=progress`} className="font-semibold text-indigo-600 hover:text-indigo-700">
                    {group.order_no}
                  </Link>
                ) : (
                  <span className="font-semibold text-gray-900">{group.order_no}</span>
                )}
                {group.customer && <span className="text-sm text-gray-600">· {group.customer}</span>}
              </div>
              <div className="text-xs text-gray-500 flex items-center gap-3">
                {group.sales && <span>业务: {group.sales}</span>}
                {group.merchandiser && <span>跟单: {group.merchandiser}</span>}
              </div>
            </div>
            <ul className="divide-y divide-gray-100">
              {group.items.map((item, idx) => (
                <li key={idx} className="px-4 py-3">
                  <div className="flex items-start gap-3">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded ${badgeClass} shrink-0`}>
                      {item.issue}
                    </span>
                    <span className="text-sm text-gray-700">{item.action}</span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
