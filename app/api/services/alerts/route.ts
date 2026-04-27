// ============================================================
// API: /api/services/alerts
// GET  ?limit=20&severity=critical&entityType=order  → 获取活跃告警
// POST { action: 'resolve', alertId, resolvedBy }    → 解决告警
// POST { action: 'resolve_stale' }                  → Cron: 清理过期告警
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getActiveAlerts, resolveAlert, resolveStaleAlerts } from '@/lib/services/alerts.service'

async function requireAdmin(supabase: any) {
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single()

  const isAdmin = profile?.role === 'admin' ||
    (Array.isArray(profile?.roles) && profile.roles.includes('admin'))

  return isAdmin ? user : null
}

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const { searchParams } = new URL(req.url)

  const severity = searchParams.get('severity') as any
  const entityType = searchParams.get('entityType') as any
  const limit = Number(searchParams.get('limit') ?? '20')

  const result = await getActiveAlerts(supabase, { severity, entityType, limit })

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ data: result.data })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const user = await requireAdmin(supabase)
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { action } = body

  if (action === 'resolve') {
    const { alertId, resolvedBy } = body
    if (!alertId) return NextResponse.json({ error: 'alertId required' }, { status: 400 })

    const result = await resolveAlert(supabase, alertId, resolvedBy ?? user.id)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  if (action === 'resolve_stale') {
    const result = await resolveStaleAlerts(supabase)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ ok: true, resolved: result.data })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
