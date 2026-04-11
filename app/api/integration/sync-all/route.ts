// ============================================================
// POST /api/integration/sync-all — 一次性同步所有历史订单到财务系统
// 安全：需要CRON_SECRET或管理员调用
// ============================================================

import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { syncOrderToFinance } from '@/lib/integration/finance-sync'

export async function POST(request: Request) {
  // 简单鉴权
  const authHeader = request.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    // 也允许登录用户调用
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
  }

  try {
    const supabase = await createClient()

    // 获取所有订单
    const { data: orders, error } = await (supabase.from('orders') as any)
      .select('*')
      .order('created_at', { ascending: true })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!orders?.length) {
      return NextResponse.json({ status: 'ok', synced: 0, message: '没有订单需要同步' })
    }

    let synced = 0
    let failed = 0
    const errors: string[] = []

    for (const order of orders) {
      try {
        const result = await syncOrderToFinance(order, 'order.created')
        if (result.success) {
          synced++
        } else {
          failed++
          errors.push(`${order.order_no}: ${result.error}`)
        }
      } catch (e) {
        failed++
        errors.push(`${order.order_no}: ${e instanceof Error ? e.message : 'unknown'}`)
      }

      // 每个订单间隔100ms，避免过快触发速率限制
      await new Promise(r => setTimeout(r, 100))
    }

    return NextResponse.json({
      status: 'ok',
      total: orders.length,
      synced,
      failed,
      errors: errors.slice(0, 10), // 只返回前10个错误
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
