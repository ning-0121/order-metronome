// ============================================================
// Trade OS — System Alerts Service
// 职责：创建/去重/解决 系统告警
// 原则：所有告警都有 alert_key，同 key 不重复创建
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ok, err,
  type ServiceResult,
  type CreateAlertInput,
  type SystemAlert,
  type AlertType,
  type AlertSeverity,
} from './types'

// ── 告警去重 Key 生成规则 ────────────────────────────────────
// 格式：{alert_type}:{entity_id}
// 相同来源的告警只保留一条（利用 DB UNIQUE 索引）
function buildAlertKey(alertType: AlertType, entityId?: string): string {
  return entityId ? `${alertType}:${entityId}` : alertType
}

// ── 利润阈值常量（统一在这里定义，不散落各处）────────────────
export const MARGIN_THRESHOLDS = {
  HEALTHY: 0.15,    // >= 15% → healthy
  WARNING: 0.10,    // 10-15% → warning
  CRITICAL: 0.0,    // 0-10% → critical
  // < 0 → negative
} as const

// ─────────────────────────────────────────────────────────────
// createSystemAlert
// 创建告警，自动去重（同 alert_key 的未解决告警只保留一条）
// ─────────────────────────────────────────────────────────────
export async function createSystemAlert(
  supabase: SupabaseClient,
  input: CreateAlertInput
): Promise<ServiceResult<{ created: boolean; alertId: string }>> {
  try {
    const alertKey = buildAlertKey(input.alertType, input.entityId)
    const autoResolveAt = input.autoResolveHours
      ? new Date(Date.now() + input.autoResolveHours * 3600 * 1000).toISOString()
      : null

    const payload = {
      alert_type: input.alertType,
      severity: input.severity,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      title: input.title,
      description: input.description ?? null,
      data_json: input.data ?? {},
      alert_key: alertKey,
      auto_resolve_at: autoResolveAt,
      is_read: false,
      is_resolved: false,
    }

    // upsert：同 alert_key + is_resolved=false 只保留一条
    // 若已存在则更新 title/description（数据可能有变化）
    const { data, error } = await (supabase.from('system_alerts') as any)
      .upsert(payload, {
        onConflict: 'alert_key',
        ignoreDuplicates: false,
      })
      .select('id')
      .single()

    if (error) {
      // 唯一约束冲突：告警已存在，视为正常（不是 error）
      if (error.code === '23505') {
        const { data: existing } = await (supabase.from('system_alerts') as any)
          .select('id')
          .eq('alert_key', alertKey)
          .eq('is_resolved', false)
          .single()
        return ok({ created: false, alertId: existing?.id ?? '' })
      }
      return err(`Failed to create alert: ${error.message}`, error.code)
    }

    return ok({ created: true, alertId: data.id })
  } catch (e: any) {
    return err(`createSystemAlert exception: ${e?.message}`)
  }
}

// ─────────────────────────────────────────────────────────────
// createAlertsBatch
// 批量创建告警（事务性，全成功或报告失败数）
// ─────────────────────────────────────────────────────────────
export async function createAlertsBatch(
  supabase: SupabaseClient,
  alerts: CreateAlertInput[]
): Promise<ServiceResult<{ created: number; skipped: number; errors: string[] }>> {
  const results = await Promise.allSettled(
    alerts.map(a => createSystemAlert(supabase, a))
  )

  let created = 0
  let skipped = 0
  const errors: string[] = []

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.ok) {
      if (r.value.data.created) created++
      else skipped++
    } else {
      const msg = r.status === 'rejected'
        ? r.reason?.message
        : !r.value.ok ? r.value.error : 'unknown'
      errors.push(msg)
    }
  }

  return ok({ created, skipped, errors })
}

// ─────────────────────────────────────────────────────────────
// resolveAlert
// 手动解决一条告警
// ─────────────────────────────────────────────────────────────
export async function resolveAlert(
  supabase: SupabaseClient,
  alertId: string,
  resolvedBy: string
): Promise<ServiceResult<void>> {
  const { error } = await (supabase.from('system_alerts') as any)
    .update({
      is_resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy,
    })
    .eq('id', alertId)

  if (error) return err(error.message)
  return ok(undefined)
}

// ─────────────────────────────────────────────────────────────
// resolveAlertByKey
// 按 alert_key 自动解决（业务状态变化时调用，如利润恢复正常）
// ─────────────────────────────────────────────────────────────
export async function resolveAlertByKey(
  supabase: SupabaseClient,
  alertType: AlertType,
  entityId?: string
): Promise<ServiceResult<number>> {
  const alertKey = buildAlertKey(alertType, entityId)
  const { data, error } = await (supabase.from('system_alerts') as any)
    .update({
      is_resolved: true,
      resolved_at: new Date().toISOString(),
    })
    .eq('alert_key', alertKey)
    .eq('is_resolved', false)
    .select('id')

  if (error) return err(error.message)
  return ok((data || []).length)
}

// ─────────────────────────────────────────────────────────────
// resolveStaleAlerts
// Cron 调用：自动解决已过 auto_resolve_at 的告警
// ─────────────────────────────────────────────────────────────
export async function resolveStaleAlerts(
  supabase: SupabaseClient
): Promise<ServiceResult<number>> {
  const { data, error } = await (supabase.from('system_alerts') as any)
    .update({
      is_resolved: true,
      resolved_at: new Date().toISOString(),
    })
    .eq('is_resolved', false)
    .lt('auto_resolve_at', new Date().toISOString())
    .select('id')

  if (error) return err(error.message)
  return ok((data || []).length)
}

// ─────────────────────────────────────────────────────────────
// getActiveAlerts
// 读取活跃告警（用于首页 banner / admin 视图）
// ─────────────────────────────────────────────────────────────
export async function getActiveAlerts(
  supabase: SupabaseClient,
  options?: {
    severity?: AlertSeverity
    entityType?: string
    limit?: number
  }
): Promise<ServiceResult<SystemAlert[]>> {
  let query = (supabase.from('system_alerts') as any)
    .select('*')
    .eq('is_resolved', false)
    .order('severity', { ascending: false })  // critical 优先
    .order('created_at', { ascending: false })

  if (options?.severity) {
    query = query.eq('severity', options.severity)
  }
  if (options?.entityType) {
    query = query.eq('entity_type', options.entityType)
  }
  if (options?.limit) {
    query = query.limit(options.limit)
  }

  const { data, error } = await query
  if (error) return err(error.message)
  return ok(data as SystemAlert[])
}
