import { getRuntimeOrderForDisplay } from '@/app/actions/runtime-confidence';
import { RuntimeRiskCard } from '@/components/RuntimeRiskCard';
import type { RuntimeRiskLevel } from '@/lib/runtime/types';

/**
 * 交付置信度风险卡的挂载位(2026-07-24:此前 RuntimeRiskCard 从未被挂载,风险卡看不到)。
 * 服务端自取数据:flag=off / 灰度非 admin / 该单无 runtime_orders 数据 → getRuntimeOrderForDisplay 返回 null → 不渲染。
 * 所以即便 RUNTIME_CONFIDENCE_ENGINE 还是 off,挂上也完全无副作用;把 env 调成 admin/on 即点亮。
 */
export async function RuntimeRiskCardSlot({ orderId }: { orderId: string }) {
  let data: any = null;
  try { data = (await getRuntimeOrderForDisplay(orderId)).data ?? null; } catch { data = null; }
  if (!data || !data.explain_json) return null;
  return (
    <div className="mb-4">
      <RuntimeRiskCard
        confidence={Number(data.delivery_confidence) || 0}
        riskLevel={(data.risk_level || 'green') as RuntimeRiskLevel}
        predictedFinishDate={data.predicted_finish_date ?? null}
        bufferDays={data.buffer_days ?? null}
        explain={data.explain_json}
      />
    </div>
  );
}
