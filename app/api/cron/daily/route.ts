// ============================================================
// Cron: /api/cron/daily
// 每天早上 8:00 执行（Vercel Cron 配置在 vercel.json）
// 串行执行所有日常任务，防止资源竞争
// 鉴权：CRON_SECRET 环境变量（Vercel 自动注入）
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncAllCustomerRhythms } from '@/lib/services/customer-rhythm.service'
import { resolveStaleAlerts } from '@/lib/services/alerts.service'
import { generateDailyTasks } from '@/lib/services/daily-tasks.service'

export async function GET(req: NextRequest) {
  // Vercel Cron 鉴权（生产环境必须）
  const authHeader = req.headers.get('authorization')
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startTime = Date.now()
  const log: string[] = []

  try {
    const supabase = await createClient()
    const today = new Date().toISOString().split('T')[0]

    // Step 1: 同步客户节奏
    log.push('→ Syncing customer rhythms...')
    const rhythmResult = await syncAllCustomerRhythms(supabase)
    if (rhythmResult.ok) {
      log.push(`  ✓ Rhythms: ${rhythmResult.data.updated} updated, ${rhythmResult.data.errors.length} errors`)
    } else {
      log.push(`  ✗ Rhythms failed: ${rhythmResult.error}`)
    }

    // Step 2: 清理过期告警
    log.push('→ Resolving stale alerts...')
    const alertResult = await resolveStaleAlerts(supabase)
    if (alertResult.ok) {
      log.push(`  ✓ Alerts: ${alertResult.data} resolved`)
    } else {
      log.push(`  ✗ Alerts failed: ${alertResult.error}`)
    }

    // Step 3: 生成今日任务
    log.push('→ Generating daily tasks...')
    const taskResult = await generateDailyTasks(supabase, {
      trigger: 'daily_cron',
      date: today,
    })
    if (taskResult.ok) {
      log.push(`  ✓ Tasks: ${taskResult.data.created} created, ${taskResult.data.skipped} skipped`)
      if (taskResult.data.errors.length > 0) {
        log.push(`  ! Task errors: ${taskResult.data.errors.join(', ')}`)
      }
    } else {
      log.push(`  ✗ Tasks failed: ${taskResult.error}`)
    }

    const duration = Date.now() - startTime
    log.push(`\n✅ Daily cron completed in ${duration}ms`)

    console.log(log.join('\n'))
    return NextResponse.json({
      ok: true,
      date: today,
      duration,
      log,
    })
  } catch (e: any) {
    console.error('Daily cron exception:', e)
    return NextResponse.json({
      ok: false,
      error: e?.message,
      log,
    }, { status: 500 })
  }
}
