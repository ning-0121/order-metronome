/**
 * 每日订单审计扫描 — 找出员工操作和输入问题
 *
 * 每天早上 8:30 运行，扫描所有进行中订单，检查：
 * 1. 缺内部单号
 * 2. 缺工厂（仅当订单已越过"工厂必须已知"的阶段 —— 见 audit-routing）
 * 3. 缺跟单负责人
 * 4. 逾期未处理的节点
 * 5. 异常数据（数量为0、出厂日期在过去等）
 * 6. 长期未更新的订单
 *
 * 2026-08-13 CEO 拍板改造三处（此前 122 条问题只发 admin 一份流水账，没人看得动）：
 *   ① 阶段门槛：「未指定工厂」实测 62 条里 39 条根本还没走到定工厂的阶段（61% 假警报）
 *   ② 按类型路由：行政督导 + 对口主管各收自己那摊（见 lib/domain/audit-routing.ts）
 *   ③ 按人聚合：主管收到的是「Winnie 6 单 / 陈陈 5 单」，不是 62 行流水
 */

import { createClient } from '@/lib/supabase/server';
import { runAutomationJob } from '@/lib/automation/run-job';
import { fetchAllPages } from '@/lib/db/truth-query';
import {
  AUDIT_KIND_CN,
  factoryShouldBeKnown,
  recipientRolesForIssue,
  type AuditIssueKind,
} from '@/lib/domain/audit-routing';
import { NextResponse } from 'next/server';

export const maxDuration = 30;

export async function POST(req: Request) {
  // 鉴权:Cron secret 或浏览器管理员登录态(数据读写一律 service-role,session 只用来验人)
  const authHeader = req.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;
  const isCron = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  if (!isCron) {
    const session = await createClient();
    const { data: { user } } = await session.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Please login first' }, { status: 401 });
  }

  const r = await runAutomationJob('order-audit', { trigger: isCron ? 'cron' : 'manual' }, runAudit);
  return NextResponse.json({
    ok: r.status !== 'failed', status: r.status, health: r.health,
    run_id: r.runId, reasons: r.reasons, ...(r.outcome.metadata || {}),
  }, { status: r.httpStatus });
}

async function runAudit(supabase: any) {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // 查所有进行中订单（含创建者和跟单）
    const { data: orders, error: ordersErr } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, factory_name, internal_order_no, quantity, factory_date, owner_user_id, created_by, lifecycle_status, updated_at, incoterm')
      .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")');
    if (ordersErr) return { errorCode: 'ORDERS_READ_FAILED', errorMessage: ordersErr.message };

    if (!orders || orders.length === 0) {
      // 全库零在途单在本业务里不可能 —— 读到 0 视为读取异常,不是 no_work
      return { errorCode: 'ZERO_ORDERS', errorMessage: '在途订单读到 0 张,判定读取异常' };
    }

    interface AuditIssue {
      kind: AuditIssueKind;           // 分组用 kind,不用带天数的展示文案
      severity: 'high' | 'medium' | 'low';
      order_no: string;
      order_id: string;
      customer: string;
      sales: string;
      merchandiser: string;
      issue: string;
      action: string;
      owner_roles?: string[];         // 仅节点逾期:逾期涉及哪些部门 → 决定该找哪几个主管
    }

    // 「工厂必须已知」阶段判定:一次性拉所有在途单的里程碑(分页,防 1000 行静默截断)
    const orderIds = (orders as any[]).map((o) => o.id);
    const { rows: allMilestones, error: msErr } = await fetchAllPages<any>((from, to) =>
      (supabase.from('milestones') as any)
        .select('order_id, step_key, status')
        .in('order_id', orderIds)
        .range(from, to),
    );
    if (msErr) return { errorCode: 'MILESTONES_READ_FAILED', errorMessage: msErr };
    const msByOrder = new Map<string, any[]>();
    for (const m of allMilestones) {
      const arr = msByOrder.get(m.order_id) || [];
      arr.push(m);
      msByOrder.set(m.order_id, arr);
    }
    let factoryGateSuppressed = 0;   // 被阶段门槛挡下的假警报数,进 metadata 便于观察口径

    // 解析所有用户名
    const userIds = new Set<string>();
    for (const o of (orders || []) as any[]) {
      if (o.created_by) userIds.add(o.created_by);
      if (o.owner_user_id) userIds.add(o.owner_user_id);
    }
    let nameMap: Record<string, string> = {};
    if (userIds.size > 0) {
      const { data: profiles } = await (supabase.from('profiles') as any)
        .select('user_id, name, email').in('user_id', Array.from(userIds));
      nameMap = (profiles || []).reduce((m: any, p: any) => {
        m[p.user_id] = p.name || p.email?.split('@')[0] || '';
        return m;
      }, {} as Record<string, string>);
    }

    const issues: AuditIssue[] = [];

    for (const order of orders as any[]) {
      const salesName = order.created_by ? (nameMap[order.created_by] || '未知') : '未知';
      const merchName = order.owner_user_id ? (nameMap[order.owner_user_id] || '未指定') : '未指定';
      const base = {
        order_no: order.order_no,
        order_id: order.id,
        customer: order.customer_name || '?',
        sales: salesName,
        merchandiser: merchName,
      };

      // 1. 缺内部单号
      if (!order.internal_order_no?.trim()) {
        issues.push({
          ...base, kind: 'missing_internal_no', severity: 'medium',
          issue: '缺内部单号',
          action: '请业务补填内部订单号（订单册编号）',
        });
      }

      // 2. 缺工厂 —— 只在订单已越过「工厂必须已知」阶段时才算问题。
      //    否则就是把「还没到时候」当成「没做」,主管收两天噪音就不看了。
      if (!order.factory_name?.trim()) {
        if (factoryShouldBeKnown(msByOrder.get(order.id) || [])) {
          issues.push({
            ...base, kind: 'missing_factory', severity: 'high',
            issue: '未指定工厂',
            action: '订单已进入生产/采购阶段仍未填工厂，请生产主管确认并回填',
          });
        } else {
          factoryGateSuppressed++;
        }
      }

      // 3. 缺跟单负责人
      if (!order.owner_user_id) {
        issues.push({
          ...base, kind: 'missing_merchandiser', severity: 'high',
          issue: '未指定跟单负责人',
          action: '请生产主管指派跟单',
        });
      }

      // 4. 数量异常
      if (!order.quantity || order.quantity <= 0) {
        issues.push({
          ...base, kind: 'zero_quantity', severity: 'high',
          issue: '订单数量为 0 或未填',
          action: '请业务确认订单数量',
        });
      }

      // 5. 出厂日期已过但订单还在进行
      if (order.factory_date) {
        const factoryDate = new Date(order.factory_date);
        const daysPast = Math.ceil((now.getTime() - factoryDate.getTime()) / 86400000);
        if (daysPast > 7) {
          issues.push({
            ...base, kind: 'factory_date_overdue', severity: 'high',
            issue: `出厂日期已过 ${daysPast} 天但订单未完成`,
            action: '请确认是否延期或标记完成',
          });
        }
      }

      // 6. 长期未更新（超过 14 天没任何操作）
      if (order.updated_at) {
        const daysSinceUpdate = Math.ceil((now.getTime() - new Date(order.updated_at).getTime()) / 86400000);
        if (daysSinceUpdate > 14) {
          issues.push({
            ...base, kind: 'stale_order', severity: 'medium',
            issue: `${daysSinceUpdate} 天未更新`,
            action: '请确认订单是否还在进行',
          });
        }
      }
    }

    // 7. 查逾期节点（分页，防 1000 行静默截断）
    const { rows: overdueMilestones } = await fetchAllPages<any>((from, to) =>
      (supabase.from('milestones') as any)
        .select('id, name, step_key, owner_role, due_at, order_id')
        .in('status', ['in_progress', '进行中'])
        .lt('due_at', today + 'T00:00:00')
        .range(from, to),
    );

    const orderById = new Map((orders as any[]).map((o) => [o.id, o]));
    // 按订单归并：既统计条数，也记住"逾期的是哪些部门的节点"→ 决定找哪几个主管
    const overdueByOrder = new Map<string, { count: number; roles: Set<string>; names: string[] }>();
    for (const ms of overdueMilestones) {
      if (!orderById.has(ms.order_id)) continue;   // 只看在途单，已完成/取消的不督办
      const e = overdueByOrder.get(ms.order_id) || { count: 0, roles: new Set<string>(), names: [] };
      e.count++;
      if (ms.owner_role) e.roles.add(String(ms.owner_role));
      if (e.names.length < 4 && ms.name) e.names.push(ms.name);
      overdueByOrder.set(ms.order_id, e);
    }

    for (const [orderId, e] of overdueByOrder) {
      if (e.count < 3) continue;
      const order = orderById.get(orderId) as any;
      // 一张单一条（不按部门拆条，否则总数虚高）；逾期涉及的部门放 owner_roles，路由时展开
      issues.push({
        kind: 'milestone_overdue',
        severity: 'high',
        order_no: order.order_no,
        order_id: orderId,
        customer: order.customer_name || '?',
        sales: order.created_by ? (nameMap[order.created_by] || '未知') : '未知',
        merchandiser: order.owner_user_id ? (nameMap[order.owner_user_id] || '未指定') : '未指定',
        owner_roles: Array.from(e.roles),
        issue: `${e.count} 个节点逾期未处理${e.names.length ? `（${e.names.join('、')}）` : ''}`,
        action: '请相关负责人立即跟进',
      });
    }

    // ── 发通知给管理员(R1-B:结果必须核对 —— 该段的前身停发了 73 天没人知道:
    //    notifications.payload 列生产不存在,插入失败被吞,cron 天天 200。
    //    列已由 20260808 迁移补上;这里四项账让 audit_hits 与 notifications_created 可对账)──
    let notificationsAttempted = 0, notificationsCreated = 0, notificationsFailed = 0;
    // 幂等:同一天已发过 daily_audit 就不重复发(重试/手动补跑不会刷屏)
    const { data: dupToday } = await supabase.from('notifications')
      .select('id').eq('type', 'daily_audit').gte('created_at', today + 'T00:00:00').limit(1);
    let routedRecipients = 0;
    if (issues.length > 0 && !(dupToday || []).length) {
      const highCount = issues.filter(i => i.severity === 'high').length;
      const mediumCount = issues.filter(i => i.severity === 'medium').length;

      // ── 按人聚合渲染:主管看到的是「Winnie 6 单 · 陈陈 5 单」,不是 62 行流水 ──
      const renderDigest = (list: AuditIssue[]) => {
        const byKind = new Map<AuditIssueKind, AuditIssue[]>();
        for (const i of list) byKind.set(i.kind, [...(byKind.get(i.kind) || []), i]);
        const order: AuditIssueKind[] = ['missing_factory', 'factory_date_overdue', 'milestone_overdue',
          'missing_merchandiser', 'zero_quantity', 'missing_internal_no', 'stale_order'];
        const lines: string[] = [];
        for (const kind of order) {
          const arr = byKind.get(kind);
          if (!arr?.length) continue;
          // 责任人维度归并:未指定工厂/跟单看跟单,其余看业务
          const owner = (i: AuditIssue) =>
            (kind === 'missing_factory' || kind === 'milestone_overdue' ? i.merchandiser : i.sales) || '未指定';
          const byPerson = new Map<string, string[]>();
          for (const i of arr) byPerson.set(owner(i), [...(byPerson.get(owner(i)) || []), i.order_no]);
          const people = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length)
            .map(([p, nos]) => `${p} ${nos.length} 单`).join(' · ');
          lines.push(`【${AUDIT_KIND_CN[kind]}】${arr.length} 单\n   ${people}\n   ${arr.slice(0, 6).map(i => i.order_no).join('、')}${arr.length > 6 ? ` 等 ${arr.length} 单` : ''}`);
        }
        return lines.join('\n\n');
      };

      const { data: profs } = await supabase.from('profiles').select('user_id, name, role, roles');
      const rolesOf = (p: any): string[] => (p?.roles?.length ? p.roles : [p?.role].filter(Boolean));
      const usersWithRole = (role: string) =>
        ((profs || []) as any[]).filter((p) => rolesOf(p).includes(role)).map((p) => p.user_id);

      // 收件人 → 他该看的问题（admin 收全量，其余按 AUDIT_ROUTING 分发）
      const inbox = new Map<string, AuditIssue[]>();
      const addTo = (uid: string, issue: AuditIssue) => inbox.set(uid, [...(inbox.get(uid) || []), issue]);
      for (const uid of usersWithRole('admin')) for (const i of issues) addTo(uid, i);
      for (const issue of issues) {
        for (const role of recipientRolesForIssue(issue.kind, issue.owner_roles)) {
          for (const uid of usersWithRole(role)) {
            // admin 已收全量，别重复推
            if ((inbox.get(uid) || []).includes(issue)) continue;
            addTo(uid, issue);
          }
        }
      }

      const { insertNotifications } = await import('@/lib/utils/notifications');
      const rows = [...inbox.entries()].map(([uid, list]) => {
        const high = list.filter(i => i.severity === 'high').length;
        const isFull = list.length === issues.length;
        return {
          user_id: uid, type: 'daily_audit',
          title: isFull
            ? `📋 每日审计：${highCount} 个严重问题，${mediumCount} 个需关注`
            : `📋 待督办：${list.length} 项${high ? `（${high} 项严重）` : ''}`,
          message: `${isFull ? `扫描 ${orders.length} 个订单，` : ''}${renderDigest(list)}`,
          status: 'unread',
          payload: {
            scanned_at: now.toISOString(), total_scanned: orders.length,
            total_issues: list.length, scope: isFull ? 'all' : 'routed',
            high_count: high, medium_count: list.length - high, issues: list,
          },
        };
      });
      routedRecipients = rows.filter(r => r.payload.scope === 'routed').length;
      notificationsAttempted = rows.length;
      const res = await insertNotifications(rows as any);
      if (res.ok) notificationsCreated = rows.length;
      else { notificationsFailed = rows.length; console.error('[order-audit] 通知写入失败:', res.error); }
    }

    return {
      eligible: issues.length,
      processed: issues.length > 0 ? ((dupToday || []).length ? issues.length : notificationsCreated > 0 ? issues.length : 0) : 0,
      rowsRead: orders.length,
      notificationsCreated,
      failedItems: notificationsFailed,
      metadata: {
        audit_hits: issues.length,
        notifications_attempted: notificationsAttempted,
        notifications_created: notificationsCreated,
        notifications_failed: notificationsFailed,
        dedupe_hit: (dupToday || []).length > 0,
        high: issues.filter(i => i.severity === 'high').length,
        medium: issues.filter(i => i.severity === 'medium').length,
        routed_recipients: routedRecipients,          // 收到分类督办的主管人数
        factory_gate_suppressed: factoryGateSuppressed, // 被阶段门槛挡下的「未指定工厂」假警报
      },
    };
}

export async function GET(req: Request) {
  return POST(req);
}
