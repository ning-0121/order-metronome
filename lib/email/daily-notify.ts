/**
 * 邮件归纳·每日晨间通知(Phase 2 E4,2026-07-25 CEO 批)。
 * 读时零 AI:从 mail_inbox 已物化的归纳列拼装,给每个业务执行发一条站内通知(邮件外推按 kill-switch 仍关)。
 * 归属自己的邮件通知本人;无人归属的高重点(投诉/交期)通知销售主管/admin,别让它掉地上。
 */

import { createServiceRoleClient } from '@/lib/supabase/server';
import { CATEGORY_LABEL, type MailCategory } from './classify';

interface Row {
  id: string; category: MailCategory | null; importance: number | null;
  needs_action: boolean | null; assigned_exec_id: string | null; handled_status: string | null;
}

function summarize(rows: Row[]): { key: number; action: number; catLine: string } {
  const key = rows.filter((r) => (r.importance ?? 0) >= 3).length;
  const action = rows.filter((r) => r.needs_action).length;
  const catCount = new Map<string, number>();
  for (const r of rows) if (r.category) catCount.set(r.category, (catCount.get(r.category) || 0) + 1);
  const catLine = [...catCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${CATEGORY_LABEL[c as MailCategory] || c}${n}`)
    .join(' · ');
  return { key, action, catLine };
}

async function insertNotif(svc: any, userId: string, title: string, message: string) {
  try {
    await (svc.from('notifications') as any).insert({
      user_id: userId, type: 'mail_digest', title, message,
      related_order_id: null, status: 'unread', email_sent: false,
    });
  } catch { /* 单条失败不阻断 */ }
}

/** 跑一轮晨间通知。返回发出的通知数。 */
export async function runDailyMailNotify(): Promise<{ execNotified: number; managerNotified: number; scanned: number }> {
  const svc = createServiceRoleClient();
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  // 近 24h 已归纳、未处理、非噪音、且(重点度≥2 或 需行动)的邮件
  const { data: rows } = await (svc.from('mail_inbox') as any)
    .select('id, category, importance, needs_action, assigned_exec_id, handled_status')
    .not('digested_at', 'is', null)
    .neq('category', '噪音')
    .gte('received_at', since)
    .in('handled_status', ['unread', 'seen'])
    .or('importance.gte.2,needs_action.eq.true');
  const list = (rows || []) as Row[];
  if (list.length === 0) return { execNotified: 0, managerNotified: 0, scanned: 0 };

  // 归属分组
  const byExec = new Map<string, Row[]>();
  const unassignedKey: Row[] = [];
  for (const r of list) {
    if (r.assigned_exec_id) {
      const arr = byExec.get(r.assigned_exec_id) || [];
      arr.push(r); byExec.set(r.assigned_exec_id, arr);
    } else if ((r.importance ?? 0) >= 3) {
      unassignedKey.push(r);   // 无人归属的高重点 → 兜给主管
    }
  }

  let execNotified = 0;
  for (const [execId, rs] of byExec) {
    const { key, action, catLine } = summarize(rs);
    const title = `📬 邮件归纳:${rs.length} 封待看${key > 0 ? ` · 🔴重点 ${key}` : ''}`;
    const message = `近一天归属你的邮件 ${rs.length} 封` +
      `${key > 0 ? `,其中重点 ${key} 封(投诉/交期/紧急)` : ''}` +
      `${action > 0 ? `,需你处理 ${action} 封` : ''}。` +
      `${catLine ? `[${catLine}] ` : ''}到「📬 邮件归纳」查看与处理。`;
    await insertNotif(svc, execId, title, message);
    execNotified++;
  }

  // 无人归属的高重点 → 通知销售主管/admin(别掉地上)
  let managerNotified = 0;
  if (unassignedKey.length > 0) {
    const { data: mgrs } = await (svc.from('profiles') as any).select('user_id, role, roles');
    const targets = (mgrs || []).filter((p: any) => {
      const rr: string[] = p.roles?.length ? p.roles : [p.role].filter(Boolean);
      return rr.some((x) => ['admin', 'sales_manager', 'order_manager', 'admin_assistant'].includes(x));
    });
    const { key, catLine } = summarize(unassignedKey);
    for (const t of targets) {
      await insertNotif(svc, t.user_id,
        `📬 ${unassignedKey.length} 封高重点邮件未归属`,
        `有 ${unassignedKey.length} 封高重点邮件(${catLine})未匹配到订单负责人。请到「📬 邮件归纳」认领/分派,别让重点掉地上。`);
      managerNotified++;
    }
  }

  return { execNotified, managerNotified, scanned: list.length };
}
