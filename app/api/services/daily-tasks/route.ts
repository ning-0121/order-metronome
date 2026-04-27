// ============================================================
// API: /api/services/daily-tasks
// GET  ?date=YYYY-MM-DD&status=pending  → 用户今日任务列表
// GET  ?summary=1                       → 任务统计
// POST { action: 'generate', trigger }  → 生成任务（Cron/事件）
// POST { action: 'update', taskId, status, snoozedUntil? } → 更新状态
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  getDailyTasks,
  getTasksSummary,
  generateDailyTasks,
  updateTaskStatus,
} from '@/lib/services/daily-tasks.service'
import type { TaskGenerationTrigger } from '@/lib/services/types'

async function getCurrentUser(supabase: any) {
  const { data: { user } } = await supabase.auth.getUser()
  return user ?? null
}

async function requireAdmin(supabase: any) {
  const user = await getCurrentUser(supabase)
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
  const user = await getCurrentUser(supabase)
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const taskDate = searchParams.get('date') ?? undefined
  const status = searchParams.get('status') as any
  const taskType = searchParams.get('taskType') as any
  const summary = searchParams.get('summary') === '1'

  if (summary) {
    const result = await getTasksSummary(supabase, user.id, taskDate)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })
    return NextResponse.json({ data: result.data })
  }

  const result = await getDailyTasks(supabase, user.id, { taskDate, status, taskType })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

  return NextResponse.json({ data: result.data })
}

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const body = await req.json()
  const { action } = body

  if (action === 'generate') {
    // 任务生成需要 admin 权限
    const admin = await requireAdmin(supabase)
    if (!admin) return NextResponse.json({ error: 'Admin only' }, { status: 403 })

    const { trigger } = body as { trigger: TaskGenerationTrigger }
    if (!trigger) return NextResponse.json({ error: 'trigger required' }, { status: 400 })

    const result = await generateDailyTasks(supabase, trigger)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

    return NextResponse.json({ data: result.data })
  }

  if (action === 'update') {
    // 状态更新：用户自己操作
    const user = await getCurrentUser(supabase)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { taskId, status, snoozedUntil } = body
    if (!taskId || !status) {
      return NextResponse.json({ error: 'taskId and status required' }, { status: 400 })
    }

    const result = await updateTaskStatus(supabase, taskId, status, snoozedUntil)
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 })

    return NextResponse.json({ ok: true })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}
