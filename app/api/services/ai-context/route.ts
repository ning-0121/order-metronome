// ============================================================
// API: /api/services/ai-context
// GET  ?type=customer&entityId=xxx&forceRefresh=1  → 获取上下文
// POST { action: 'invalidate', contextType, entityId, reason? }
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  buildCustomerContext,
  buildOrderContext,
  buildGlobalContext,
  invalidateContextCache,
} from '@/lib/services/ai-context.service'

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
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const contextType = searchParams.get('type')
  const entityId = searchParams.get('entityId') ?? ''
  const forceRefresh = searchParams.get('forceRefresh') === '1'
  const ttlHours = searchParams.get('ttlHours')
    ? Number(searchParams.get('ttlHours'))
    : undefined

  const options = { forceRefresh, ttlHours }

  let result
  if (contextType === 'customer') {
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 })
    result = await buildCustomerContext(supabase, entityId, options)
  } else if (contextType === 'order') {
    if (!entityId) return NextResponse.json({ error: 'entityId required' }, { status: 400 })
    result = await buildOrderContext(supabase, entityId, options)
  } else if (contextType === 'global') {
    result = await buildGlobalContext(supabase, options)
  } else {
    return NextResponse.json({ error: 'type must be customer|order|global' }, { status: 400 })
  }

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
  return NextResponse.json({ data: result.data })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = await requireAdmin(supabase)
  if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await req.json()
  const { action, contextType, entityId, reason } = body

  if (action === 'invalidate') {
    if (!contextType || !entityId) {
      return NextResponse.json({ error: 'contextType and entityId required' }, { status: 400 })
    }
    const result = await invalidateContextCache(supabase, contextType, entityId, reason)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
