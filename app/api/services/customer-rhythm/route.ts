// ============================================================
// API: /api/services/customer-rhythm
// GET  ?customerName=xxx         → 读取客户节奏
// GET  ?needFollowup=1&tier=A    → 需要跟进的客户列表
// POST { action: 'sync', customerName? }   → 同步单个或全部
// POST { action: 'contact', customerName, contactedAt? } → 记录联系
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getCustomerRhythm,
  getCustomersNeedingFollowup,
  updateCustomerRhythm,
  syncAllCustomerRhythms,
  recordCustomerContact,
} from '@/lib/services/customer-rhythm.service'

async function requireAuth(supabase: any) {
  const { data: { user } } = await supabase.auth.getUser()
  return user ?? null
}

async function requireSalesOrAbove(supabase: any) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single()

  const allowed = ['admin', 'finance', 'sales', 'merchandiser', 'production_manager']
  const hasRole = allowed.includes(profile?.role) ||
    (Array.isArray(profile?.roles) && profile.roles.some((r: string) => allowed.includes(r)))

  return hasRole ? user : null
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const user = await requireSalesOrAbove(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const customerName = searchParams.get('customerName')
  const needFollowup = searchParams.get('needFollowup') === '1'
  const tier = searchParams.get('tier') as any

  if (needFollowup) {
    const result = await getCustomersNeedingFollowup(supabase, { tier })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ data: result.data })
  }

  if (customerName) {
    const result = await getCustomerRhythm(supabase, customerName)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ data: result.data })
  }

  return NextResponse.json({ error: 'customerName or needFollowup=1 required' }, { status: 400 })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const user = await requireSalesOrAbove(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { action, customerName, contactedAt } = body

  if (action === 'sync') {
    if (customerName) {
      const result = await updateCustomerRhythm(supabase, customerName)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
      return NextResponse.json({ data: result.data })
    } else {
      // 全量同步（Cron 调用）
      const result = await syncAllCustomerRhythms(supabase)
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
      return NextResponse.json({ data: result.data })
    }
  }

  if (action === 'contact') {
    if (!customerName) return NextResponse.json({ error: 'customerName required' }, { status: 400 })
    const result = await recordCustomerContact(supabase, customerName, contactedAt)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
