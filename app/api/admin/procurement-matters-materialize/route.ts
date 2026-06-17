// ============================================================
// API: /api/admin/procurement-matters-materialize
// POST { mode: 'dry_run' | 'execute' }
//
// 手动物化入口（nightly cron 见 /api/cron/daily）：
//   dry_run — 只计算返回全量 matters，供人审误报，零写入
//   execute — upsert procurement_matters + 清理本轮未检出的行
// 鉴权：登录 + admin 或 采购经理(procurement_manager)；读写统一走 service-role
//   （procurement_matters 无 authenticated 写策略）。
// ============================================================

import { NextRequest, NextResponse } from 'next/server'
import { createClient, createServiceRoleClient } from '@/lib/supabase/server'
import { isAdminRole } from '@/lib/domain/roles'
import { materializeProcurementMatters } from '@/lib/services/procurement-matters.service'

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
  if (!isAdminRole(userRoles) && !userRoles.includes('procurement_manager')) {
    return NextResponse.json({ ok: false, error: '仅管理员或采购经理可触发物化' }, { status: 403 })
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

  const result = await materializeProcurementMatters(svc as any, { mode })
  if (!result.ok) {
    return NextResponse.json({ ok: false, mode, error: result.error }, { status: 500 })
  }
  return NextResponse.json({ ok: true, mode, stats: result.data.stats, matters: result.data.matters })
}
