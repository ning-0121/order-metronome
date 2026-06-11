// ============================================================
// API: /api/admin/customer-matters-materialize
// POST { mode: 'dry_run' | 'execute' }
//
// Phase 1 手动物化入口（不接 nightly cron）：
//   dry_run — 只计算返回全量 matters，供人审关键词误报，零写入
//   execute — upsert customer_matters + 清理本轮未检出的行
// 鉴权：登录 + admin 角色；读写统一走 service-role（表无 authenticated 写策略）
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { isAdminRole } from '@/lib/domain/roles'
import { materializeCustomerMatters } from '@/lib/services/customer-matters.service'

export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ ok: false, error: '请先登录' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, roles')
    .eq('user_id', user.id)
    .single()
  const userRoles: string[] = (profile as any)?.roles?.length > 0
    ? (profile as any).roles
    : [(profile as any)?.role].filter(Boolean)
  if (!isAdminRole(userRoles)) {
    return NextResponse.json({ ok: false, error: '仅管理员可触发物化' }, { status: 403 })
  }

  const body = await req.json().catch(() => ({} as any))
  const mode = body?.mode === 'execute' ? 'execute' : body?.mode === 'dry_run' ? 'dry_run' : null
  if (!mode) {
    return NextResponse.json(
      { ok: false, error: '请指定 mode: "dry_run" 或 "execute"' },
      { status: 400 },
    )
  }

  let svc
  try {
    svc = createServiceRoleClient()
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: `service-role 不可用: ${e?.message}` }, { status: 500 })
  }

  const result = await materializeCustomerMatters(svc as any, { mode })
  if (!result.ok) {
    return NextResponse.json({ ok: false, mode, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ ok: true, mode, stats: result.data.stats, matters: result.data.matters })
}
