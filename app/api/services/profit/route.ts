// ============================================================
// API: /api/services/profit
// GET  ?orderId=xxx&snapshotType=live   → 读取利润快照
// POST { orderId, snapshotType, overrides? }  → 计算并保存快照
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { calculateProfitSnapshot, getProfitSnapshot } from '@/lib/services/profit.service'

async function requireFinanceOrAdmin(supabase: any) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single()

  const allowed = ['admin', 'finance']
  const hasRole = allowed.includes(profile?.role) ||
    (Array.isArray(profile?.roles) && profile.roles.some((r: string) => allowed.includes(r)))

  return hasRole ? user : null
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const user = await requireFinanceOrAdmin(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const orderId = searchParams.get('orderId')
  const snapshotType = (searchParams.get('snapshotType') ?? 'live') as any

  if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })

  const result = await getProfitSnapshot(supabase, orderId, snapshotType)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

  return NextResponse.json({ data: result.data })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const user = await requireFinanceOrAdmin(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { orderId, snapshotType, overrides } = body

  if (!orderId) return NextResponse.json({ error: 'orderId required' }, { status: 400 })
  if (!snapshotType) return NextResponse.json({ error: 'snapshotType required' }, { status: 400 })

  const result = await calculateProfitSnapshot(supabase, {
    orderId,
    snapshotType,
    overrides,
  })

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ data: result.data })
}
