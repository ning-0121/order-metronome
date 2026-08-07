// ============================================================
// Cron: /api/cron/daily — R1-B 重写(2026-08-08)
//
// 【旧版为什么空转数月】Step 1-4 用 `await createClient()`(无登录态的
// session 客户端):cron 环境下每张表被 RLS 拒读/拒写,各 service 读到
// 0 个对象 → "处理 0 个,成功" → HTTP 200 绿灯。客户节奏/P&L 永远空表、
// 每日任务从不自主生成(全靠用户碰巧打开 /my-today)。Step 5/6 自己注释
// 都写了"必须 service-role",前四步却没人跟着改 —— 双标数月无人发现。
//
// 【本版】全步 service-role;经 runAutomationJob 统一契约:
// 每步单独记 eligible/processed/written/failed/duration,核心步骤
// eligible>0 且产出 0 → 整个 job 至少 degraded;关键 DB error → failed。
// CRON SUCCESS != HTTP 200 —— 状态由业务产出决定,并与 automation_runs 一致。
// 幂等:daily_tasks 有 UNIQUE(assigned_to,source_type,source_id,task_date);
// rhythm/PnL/matters 均为按主键 upsert/重建 —— 重试安全。
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { syncAllCustomerRhythms, rebuildAllCustomerRhythmPnl } from '@/lib/services/customer-rhythm.service'
import { resolveStaleAlerts } from '@/lib/services/alerts.service'
import { generateDailyTasks } from '@/lib/services/daily-tasks.service'
import { materializeCustomerMatters } from '@/lib/services/customer-matters.service'
import { materializeProcurementMatters } from '@/lib/services/procurement-matters.service'
import { runAutomationJob, type JobStepResult } from '@/lib/automation/run-job'

export const maxDuration = 60

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const r = await runAutomationJob('daily', { trigger: 'cron' }, async (svc) => {
    const today = new Date().toISOString().split('T')[0]
    const steps: JobStepResult[] = []
    let rowsWritten = 0

    const timed = async (step: string, critical: boolean, run: () => Promise<Partial<JobStepResult>>) => {
      const t0 = Date.now()
      try {
        const res = await run()
        steps.push({ step, critical, duration_ms: Date.now() - t0, ...res })
      } catch (e: any) {
        steps.push({ step, critical, duration_ms: Date.now() - t0, error: e?.message || String(e) })
      }
    }

    // eligible 基数:客户总数(rhythm/PnL 的处理对象)
    const { count: customerCount } = await (svc.from('customers') as any).select('*', { count: 'exact', head: true })

    // Step 1: 客户节奏(关键)
    await timed('customer_rhythm', true, async () => {
      const res = await syncAllCustomerRhythms(svc)
      if (!res.ok) return { error: res.error }
      rowsWritten += res.data.updated
      return { eligible: customerCount ?? null, written: res.data.updated, failed: res.data.errors.length }
    })

    // Step 2: 客户 P&L 画像(关键;在 rhythm 之后,行已存在)
    await timed('customer_pnl', true, async () => {
      const res = await rebuildAllCustomerRhythmPnl(svc)
      if (!res.ok) return { error: res.error }
      rowsWritten += res.data.updated
      return { eligible: customerCount ?? null, written: res.data.updated, failed: res.data.errors.length }
    })

    // Step 3: 清理过期告警(清理类:0 是常态,eligible 不设 —— 别把"没垃圾可扫"当失败)
    await timed('stale_alerts', false, async () => {
      const res = await resolveStaleAlerts(svc)
      if (!res.ok) return { error: res.error }
      return { written: res.data }
    })

    // Step 4: 生成今日任务(关键;eligible = created+skipped,skipped=幂等命中已存在)
    await timed('daily_tasks', true, async () => {
      const res = await generateDailyTasks(svc, { trigger: 'daily_cron', date: today })
      if (!res.ok) return { error: res.error }
      rowsWritten += res.data.created
      return {
        eligible: res.data.created + res.data.skipped,
        processed: res.data.created + res.data.skipped,
        written: res.data.created,
        failed: res.data.errors.length,
      }
    })

    // Step 5/6: CEO 客户事项 / 采购风险事项(原本就是 service-role,并入统一记账)
    await timed('customer_matters', false, async () => {
      const res = await materializeCustomerMatters(svc as any, { mode: 'execute' })
      if (!res.ok) return { error: res.error }
      rowsWritten += res.data.stats.written ?? 0
      return { written: res.data.stats.written ?? 0 }
    })
    await timed('procurement_matters', false, async () => {
      const res = await materializeProcurementMatters(svc as any, { mode: 'execute' })
      if (!res.ok) return { error: res.error }
      rowsWritten += res.data.stats.written ?? 0
      return { written: res.data.stats.written ?? 0 }
    })

    return { steps, rowsWritten, metadata: { date: today } }
  })

  return NextResponse.json({
    ok: r.status !== 'failed', status: r.status, health: r.health,
    run_id: r.runId, reasons: r.reasons, steps: r.outcome.steps,
  }, { status: r.httpStatus })
}
