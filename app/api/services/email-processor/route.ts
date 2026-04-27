// ============================================================
// API: /api/services/email-processor
// GET  ?requiresActionOnly=1&customerName=xxx&limit=50 → 日志列表
// POST { action: 'process', emails: RawEmail[] }       → 批量处理
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  processNewEmailsOnly,
  getRecentEmailLogs,
} from '@/lib/services/email-processor.service'
import type { RawEmail } from '@/lib/services/types'

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
  const admin = await requireAdmin(supabase)
  if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const { searchParams } = new URL(req.url)
  const requiresActionOnly = searchParams.get('requiresActionOnly') === '1'
  const customerName = searchParams.get('customerName') ?? undefined
  const limit = searchParams.get('limit') ? Number(searchParams.get('limit')) : 50

  const result = await getRecentEmailLogs(supabase, { requiresActionOnly, customerName, limit })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

  return NextResponse.json({ data: result.data })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = await requireAdmin(supabase)
  if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

  const body = await req.json()
  const { action, emails } = body

  if (action === 'process') {
    if (!Array.isArray(emails)) {
      return NextResponse.json({ error: 'emails array required' }, { status: 400 })
    }

    // 反序列化日期字段
    const rawEmails: RawEmail[] = emails.map((e: any) => ({
      ...e,
      receivedAt: new Date(e.receivedAt),
    }))

    const result = await processNewEmailsOnly(supabase, rawEmails)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

    return NextResponse.json({ data: result.data })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
