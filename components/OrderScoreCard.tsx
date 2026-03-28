'use client';

interface Commission {
  user_name: string;
  role: string;
  score_ontime: number;
  score_no_block: number;
  score_no_delay: number;
  score_quality: number;
  score_delivery: number;
  total_score: number;
  grade: string;
  commission_rate: number;
  vetoed: boolean;
  veto_reason: string | null;
  detail_json: any;
  calculated_at: string;
}

const GRADE_COLORS: Record<string, string> = {
  S: 'bg-purple-100 text-purple-700 border-purple-300',
  A: 'bg-green-100 text-green-700 border-green-300',
  B: 'bg-blue-100 text-blue-700 border-blue-300',
  C: 'bg-amber-100 text-amber-700 border-amber-300',
  D: 'bg-red-100 text-red-700 border-red-300',
};

const ROLE_LABELS: Record<string, string> = {
  sales: '业务/理单',
  merchandiser: '跟单',
};

const DIMENSION_LABELS = [
  { key: 'score_ontime', label: '节拍准时', max: 40, icon: '⏱' },
  { key: 'score_no_block', label: '零阻塞', max: 20, icon: '🟢' },
  { key: 'score_no_delay', label: '延期控制', max: 15, icon: '📅' },
  { key: 'score_quality', label: '品质达标', max: 15, icon: '✅' },
  { key: 'score_delivery', label: '准时交付', max: 10, icon: '🚢' },
];

function ScoreBar({ value, max }: { value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2 flex-1">
      <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 w-12 text-right">{value}/{max}</span>
    </div>
  );
}

function SingleScoreCard({ commission }: { commission: Commission }) {
  const gradeClass = GRADE_COLORS[commission.grade] || GRADE_COLORS.D;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">
            {ROLE_LABELS[commission.role] || commission.role}
          </span>
          <span className="text-sm text-gray-400">({commission.user_name})</span>
        </div>
        <div className="flex items-center gap-2">
          {commission.vetoed && (
            <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-700 font-medium">
              一票否决
            </span>
          )}
          <span className={`text-lg font-bold px-3 py-1 rounded-lg border ${gradeClass}`}>
            {commission.grade}
          </span>
        </div>
      </div>

      {/* Total Score */}
      <div className="flex items-baseline gap-2 mb-4">
        <span className="text-3xl font-bold text-gray-900">{commission.total_score}</span>
        <span className="text-sm text-gray-400">/ 100 分</span>
        <span className="ml-auto text-sm font-medium">
          提成系数：
          <span className={commission.commission_rate >= 1 ? 'text-green-600' : commission.commission_rate >= 0.7 ? 'text-amber-600' : 'text-red-600'}>
            {(commission.commission_rate * 100).toFixed(0)}%
          </span>
        </span>
      </div>

      {/* Dimension Bars */}
      <div className="space-y-2.5">
        {DIMENSION_LABELS.map(({ key, label, max, icon }) => (
          <div key={key} className="flex items-center gap-3">
            <span className="text-sm w-20 flex items-center gap-1 text-gray-600">
              <span className="text-xs">{icon}</span> {label}
            </span>
            <ScoreBar value={(commission as any)[key]} max={max} />
          </div>
        ))}
      </div>

      {/* Detail: overdue/blocked steps */}
      {commission.detail_json && (
        <div className="mt-4 pt-3 border-t border-gray-100 space-y-1">
          {commission.detail_json.ontime?.overdueSteps?.length > 0 && (
            <p className="text-xs text-red-500">
              逾期关卡：{commission.detail_json.ontime.overdueSteps.join('、')}
            </p>
          )}
          {commission.detail_json.noBlock?.blockedSteps?.length > 0 && (
            <p className="text-xs text-amber-600">
              阻塞关卡：{commission.detail_json.noBlock.blockedSteps.join('、')}
            </p>
          )}
          {commission.detail_json.noDelay?.delayCount > 0 && (
            <p className="text-xs text-orange-500">
              延期申请：{commission.detail_json.noDelay.delayCount} 次
            </p>
          )}
          {commission.detail_json.delivery?.daysLate != null && commission.detail_json.delivery.daysLate > 0 && (
            <p className="text-xs text-red-500">
              交付延迟：{commission.detail_json.delivery.daysLate} 天
            </p>
          )}
          {commission.veto_reason && (
            <p className="text-xs text-red-700 font-medium">
              否决原因：{commission.veto_reason}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function OrderScoreCard({ commissions }: { commissions: Commission[] }) {
  if (!commissions || commissions.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-gray-400">
        订单完成后将自动生成执行评分
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 评分说明 */}
      <div className="bg-gray-50 rounded-lg p-3 text-xs text-gray-500">
        <p className="font-medium text-gray-600 mb-1">评分标准</p>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          <span>S(95+)=110%</span>
          <span>A(85-94)=100%</span>
          <span>B(75-84)=85%</span>
          <span>C(60-74)=70%</span>
          <span>D(&lt;60)=50%</span>
        </div>
      </div>

      {/* 评分卡片 */}
      <div className="grid gap-4 md:grid-cols-2">
        {commissions.map((c: Commission, i: number) => (
          <SingleScoreCard key={i} commission={c} />
        ))}
      </div>
    </div>
  );
}
