import { computeKPIByRole, type KPIResult } from '@/lib/utils/kpi';
import { ROLE_LABEL } from '@/lib/utils/user-role';

interface KPIOverviewProps {
  milestones: {
    id: string;
    status: string;
    due_at: string | null;
    completed_at: string | null;
    owner_role: string;
    owner_user_id: string | null;
    order_id: string;
  }[];
}

export function KPIOverview({ milestones }: KPIOverviewProps) {
  const kpiByRole = computeKPIByRole(milestones);

  const sortedRoles = Object.entries(kpiByRole)
    .sort((a, b) => a[1].onTimeRate - b[1].onTimeRate); // 准时率低的排前面

  if (sortedRoles.length === 0) {
    return null;
  }

  return (
    <div className="section mb-8">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-100">
          <span className="text-emerald-600">📊</span>
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">各角色 KPI 概览</h2>
          <p className="text-sm text-gray-500">节点准时率 · 完成数 · 超期数</p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-gray-200">
        <table className="table-modern">
          <thead>
            <tr>
              <th>角色</th>
              <th>准时率</th>
              <th>已完成</th>
              <th>超期中</th>
              <th>阻塞中</th>
              <th>总节点</th>
              <th>完成进度</th>
            </tr>
          </thead>
          <tbody>
            {sortedRoles.map(([role, kpi]) => (
              <KPIRow key={role} role={role} kpi={kpi} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function KPIRow({ role, kpi }: { role: string; kpi: KPIResult }) {
  const hasRate = kpi.onTimeRate >= 0;
  const rateColor = !hasRate ? 'text-gray-400' : kpi.onTimeRate >= 80 ? 'text-green-600' : kpi.onTimeRate >= 60 ? 'text-yellow-600' : 'text-red-600';
  const rateBg = !hasRate ? 'bg-gray-300' : kpi.onTimeRate >= 80 ? 'bg-green-500' : kpi.onTimeRate >= 60 ? 'bg-yellow-500' : 'bg-red-500';

  return (
    <tr>
      <td>
        <span className="font-medium text-gray-900">{ROLE_LABEL[role] || role}</span>
      </td>
      <td>
        <span className={`font-bold ${rateColor}`}>{hasRate ? `${kpi.onTimeRate}%` : '—'}</span>
      </td>
      <td>
        <span className="text-indigo-600 font-medium">{kpi.completed}</span>
      </td>
      <td>
        {kpi.overdue > 0 ? (
          <span className="badge badge-danger">{kpi.overdue}</span>
        ) : (
          <span className="text-gray-400">0</span>
        )}
      </td>
      <td>
        {kpi.blocked > 0 ? (
          <span className="badge badge-warning">{kpi.blocked}</span>
        ) : (
          <span className="text-gray-400">0</span>
        )}
      </td>
      <td>
        <span className="text-gray-600">{kpi.total}</span>
      </td>
      <td>
        <div className="flex items-center gap-2">
          <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden max-w-20">
            <div className={`h-full ${rateBg} rounded-full`} style={{ width: `${kpi.completionRate}%` }} />
          </div>
          <span className="text-xs text-gray-500">{kpi.completionRate}%</span>
        </div>
      </td>
    </tr>
  );
}
