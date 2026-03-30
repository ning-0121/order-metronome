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

function ScoreRulesPanel() {
  return (
    <div className="space-y-4">
      {/* 引言 */}
      <div className="bg-gradient-to-br from-amber-50 via-orange-50 to-rose-50 rounded-xl p-5 border border-orange-100">
        <h3 className="text-base font-semibold text-gray-800 mb-2">我们如何看待评分？</h3>
        <p className="text-sm text-gray-600 leading-relaxed">
          评分不是为了扣钱，而是让每一份努力都被看见。
          做得好的人，理应获得更好的回报；遇到困难时，我们一起复盘、一起成长。
          这套评分的初衷很简单——<span className="text-amber-700 font-medium">让认真做事的人不吃亏</span>。
        </p>
      </div>

      {/* 五个维度 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">五个评分维度</h3>
        <div className="space-y-3">
          <div className="flex gap-3">
            <span className="text-lg flex-shrink-0 mt-0.5">⏱</span>
            <div>
              <p className="text-sm font-medium text-gray-800">节拍准时（满分 40）</p>
              <p className="text-xs text-gray-500 mt-0.5">
                你负责的关卡是否按时完成。每个逾期关卡扣 8 分。
                提前预判、主动沟通，就不会被动逾期。
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="text-lg flex-shrink-0 mt-0.5">🟢</span>
            <div>
              <p className="text-sm font-medium text-gray-800">零阻塞（满分 20）</p>
              <p className="text-xs text-gray-500 mt-0.5">
                你负责的环节是否出现过卡住。每次阻塞扣 10 分。
                发现问题及时上报，比等到卡住再处理好得多。
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="text-lg flex-shrink-0 mt-0.5">📅</span>
            <div>
              <p className="text-sm font-medium text-gray-800">延期控制（满分 15）</p>
              <p className="text-xs text-gray-500 mt-0.5">
                你负责的关卡申请了多少次延期。每次延期扣 5 分。
                合理的延期申请不丢人，但尽量提前安排好节奏。
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="text-lg flex-shrink-0 mt-0.5">✅</span>
            <div>
              <p className="text-sm font-medium text-gray-800">品质达标（满分 15）</p>
              <p className="text-xs text-gray-500 mt-0.5">
                中查和尾查是否一次通过。中查不过扣 5 分，尾查不过扣 10 分。
                这个维度业务和跟单共担——品质是团队的共同承诺。
              </p>
            </div>
          </div>
          <div className="flex gap-3">
            <span className="text-lg flex-shrink-0 mt-0.5">🚢</span>
            <div>
              <p className="text-sm font-medium text-gray-800">准时交付（满分 10）</p>
              <p className="text-xs text-gray-500 mt-0.5">
                订单是否在 ETD 前出运。准时得 10 分，迟 1-3 天得 5 分，迟 4-7 天得 0 分，超 7 天倒扣 5 分。
                最终结果业务和跟单共担，因为交付是大家一起努力的成果。
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* 等级与提成 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-3">评分等级与提成</h3>
        <div className="grid grid-cols-5 gap-2 text-center text-xs">
          <div className="rounded-lg bg-purple-50 border border-purple-200 p-3">
            <div className="text-lg font-bold text-purple-700">S</div>
            <div className="text-purple-600 font-medium mt-1">95 分以上</div>
            <div className="text-purple-500 mt-0.5">提成 110%</div>
            <div className="text-purple-400 mt-1 text-[10px]">卓越表现</div>
          </div>
          <div className="rounded-lg bg-green-50 border border-green-200 p-3">
            <div className="text-lg font-bold text-green-700">A</div>
            <div className="text-green-600 font-medium mt-1">85 - 94</div>
            <div className="text-green-500 mt-0.5">提成 100%</div>
            <div className="text-green-400 mt-1 text-[10px]">优秀执行</div>
          </div>
          <div className="rounded-lg bg-blue-50 border border-blue-200 p-3">
            <div className="text-lg font-bold text-blue-700">B</div>
            <div className="text-blue-600 font-medium mt-1">75 - 84</div>
            <div className="text-blue-500 mt-0.5">提成 85%</div>
            <div className="text-blue-400 mt-1 text-[10px]">基本达标</div>
          </div>
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
            <div className="text-lg font-bold text-amber-700">C</div>
            <div className="text-amber-600 font-medium mt-1">60 - 74</div>
            <div className="text-amber-500 mt-0.5">提成 70%</div>
            <div className="text-amber-400 mt-1 text-[10px]">需要改进</div>
          </div>
          <div className="rounded-lg bg-red-50 border border-red-200 p-3">
            <div className="text-lg font-bold text-red-700">D</div>
            <div className="text-red-600 font-medium mt-1">60 以下</div>
            <div className="text-red-500 mt-0.5">提成 50%</div>
            <div className="text-red-400 mt-1 text-[10px]">严重不足</div>
          </div>
        </div>
        <p className="text-xs text-gray-400 mt-3 text-center">
          绝大多数正常执行的订单都在 A 级以上，请放心。好好做，全额提成就是你的。
        </p>
      </div>

      {/* 特殊情况 */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">特殊情况说明</h3>
        <div className="space-y-2 text-xs text-gray-500">
          <div className="flex items-start gap-2">
            <span className="text-red-400 mt-0.5 flex-shrink-0">*</span>
            <p>如果订单因内部原因被取消，该订单提成归零。这是为了保护客户利益和公司声誉。</p>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-amber-400 mt-0.5 flex-shrink-0">*</span>
            <p>客户原因导致的延期或取消，不影响你的评分，系统会自动识别。</p>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-green-400 mt-0.5 flex-shrink-0">*</span>
            <p>评分有争议可以找管理员复核，我们尊重每一个人的付出。</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function OrderScoreCard({ commissions }: { commissions: Commission[] }) {
  if (!commissions || commissions.length === 0) {
    return <ScoreRulesPanel />;
  }

  return (
    <div className="space-y-4">
      {/* 评分卡片 */}
      <div className="grid gap-4 md:grid-cols-2">
        {commissions.map((c: Commission, i: number) => (
          <SingleScoreCard key={i} commission={c} />
        ))}
      </div>

      {/* 可折叠的评分标准 */}
      <details className="group">
        <summary className="cursor-pointer text-sm text-gray-400 hover:text-gray-600 flex items-center gap-1">
          <svg className="w-4 h-4 transition-transform group-open:rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          查看评分标准与细则
        </summary>
        <div className="mt-3">
          <ScoreRulesPanel />
        </div>
      </details>
    </div>
  );
}
