'use client';

import { useState, useEffect } from 'react';
import { calculateOrderScore } from '@/app/actions/commissions';

export function LiveScorePreview({ orderId }: { orderId: string }) {
  const [score, setScore] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    calculateOrderScore(orderId).then(res => {
      if (res.data) setScore(res.data);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, [orderId]);

  if (loading) return <div className="text-center py-8 text-gray-400">计算评分中...</div>;

  if (!score) {
    return (
      <div className="text-center py-8 text-gray-400">
        <p>暂无法计算评分（订单数据不足）</p>
      </div>
    );
  }

  const gradeColors: Record<string, string> = { S: 'text-purple-600', A: 'text-green-600', B: 'text-blue-600', C: 'text-amber-600', D: 'text-red-600' };

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-amber-50 border border-amber-200 p-4">
        <p className="text-sm font-medium text-amber-800">⏳ 实时评分预览（订单进行中，最终评分以完成时为准）</p>
      </div>

      {(score.salesScore || score.merchandiserScore) && (
        <div className="grid gap-4 md:grid-cols-2">
          {score.salesScore && (
            <div className="rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-gray-900">业务评分</h3>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-black text-indigo-600">{score.salesScore.total_score}</span>
                  <span className="text-sm text-gray-400">/100</span>
                  <span className={`text-lg font-bold ${gradeColors[score.salesScore.grade] || 'text-gray-600'}`}>{score.salesScore.grade}</span>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                {score.salesScore.detail_json && Object.entries(score.salesScore.detail_json).map(([key, val]: any) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-gray-600">{key === 'ontime' ? '节拍准时' : key === 'noBlock' ? '零阻塞' : key === 'noDelay' ? '延期控制' : key === 'quality' ? '品质达标' : key === 'delivery' ? '准时交付' : key}</span>
                    <span className={`font-medium ${val.score >= val.max * 0.8 ? 'text-green-600' : val.score >= val.max * 0.5 ? 'text-amber-600' : 'text-red-600'}`}>
                      {val.score}/{val.max}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {score.merchandiserScore && (
            <div className="rounded-xl border border-gray-200 p-5">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-bold text-gray-900">跟单评分</h3>
                <div className="flex items-baseline gap-2">
                  <span className="text-3xl font-black text-purple-600">{score.merchandiserScore.total_score}</span>
                  <span className="text-sm text-gray-400">/100</span>
                  <span className={`text-lg font-bold ${gradeColors[score.merchandiserScore.grade] || 'text-gray-600'}`}>{score.merchandiserScore.grade}</span>
                </div>
              </div>
              <div className="space-y-2 text-sm">
                {score.merchandiserScore.detail_json && Object.entries(score.merchandiserScore.detail_json).map(([key, val]: any) => (
                  <div key={key} className="flex justify-between">
                    <span className="text-gray-600">{key === 'ontime' ? '节拍准时' : key === 'noBlock' ? '零阻塞' : key === 'noDelay' ? '延期控制' : key === 'quality' ? '品质达标' : key === 'delivery' ? '准时交付' : key}</span>
                    <span className={`font-medium ${val.score >= val.max * 0.8 ? 'text-green-600' : val.score >= val.max * 0.5 ? 'text-amber-600' : 'text-red-600'}`}>
                      {val.score}/{val.max}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
