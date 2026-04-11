// ============================================================
// POST /api/integration/sync-all — 一次性同步所有历史订单到财务系统
// 使用Supabase anon key + 绕过RLS的查询方式
// ============================================================

import { NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { syncOrderToFinance } from '@/lib/integration/finance-sync'

export async function POST(request: Request) {
  // 鉴权
  const apiKey = request.headers.get('x-api-key')
  const integrationKey = process.env.INTEGRATION_API_KEY
  if (!integrationKey || apiKey !== integrationKey) {
    return NextResponse.json({ error: 'Unauthorized. Provide x-api-key header.' }, { status: 401 })
  }

  try {
    // 用service role key查询（如果有），否则用anon key
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

    // 直接用fetch调用Supabase REST API（绕过SSR client的cookie依赖）
    const res = await fetch(`${supabaseUrl}/rest/v1/orders?select=*&order=created_at.asc`, {
      headers: {
        'apikey': supabaseKey,
        'Authorization': `Bearer ${supabaseKey}`,
      },
    })

    if (!res.ok) {
      return NextResponse.json({ error: `Supabase query failed: ${res.status}` }, { status: 500 })
    }

    const orders = await res.json()

    if (!orders?.length) {
      return NextResponse.json({ status: 'ok', synced: 0, total: 0, message: '没有订单需要同步' })
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
          errors.push(`${order.order_no || order.id}: ${result.error}`)
        }
      } catch (e) {
        failed++
        errors.push(`${order.order_no || order.id}: ${e instanceof Error ? e.message : 'unknown'}`)
      }
      await new Promise(r => setTimeout(r, 100))
    }

    return NextResponse.json({
      status: 'ok',
      total: orders.length,
      synced,
      failed,
      errors: errors.slice(0, 10),
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Sync failed' },
      { status: 500 }
    )
  }
}
