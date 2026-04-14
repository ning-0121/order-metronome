/**
 * 每日订单审计扫描 — 找出员工操作和输入问题
 *
 * 每天早上 8:30 运行，扫描所有进行中订单，检查：
 * 1. 缺内部单号
 * 2. 缺工厂
 * 3. 缺跟单负责人
 * 4. 逾期未处理的节点
 * 5. 异常数据（数量为0、出厂日期在过去等）
 * 6. 长期未更新的订单
 *
 * 结果通知管理员
 */

import { createClient as createServiceClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';

export const maxDuration = 30;

export async function POST(req: Request) {
  try {
    // 支持两种认证：Cron secret 或浏览器登录态
    const authHeader = req.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;

    let supabase: any;
    if (isCron) {
      const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !serviceKey) return NextResponse.json({ error: 'Missing config' }, { status: 500 });
      supabase = createServiceClient(url, serviceKey);
    } else {
      // 浏览器访问：用登录态
      supabase = await createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return NextResponse.json({ error: 'Please login first' }, { status: 401 });
    }
    const now = new Date();
    const today = now.toISOString().slice(0, 10);

    // 查所有进行中订单（含创建者和跟单）
    const { data: orders } = await (supabase.from('orders') as any)
      .select('id, order_no, customer_name, factory_name, internal_order_no, quantity, factory_date, owner_user_id, created_by, lifecycle_status, updated_at, incoterm')
      .not('lifecycle_status', 'in', '("completed","已完成","cancelled","已取消","archived","已归档")');

    if (!orders || orders.length === 0) {
      return NextResponse.json({ success: true, issues: 0 });
    }

    interface AuditIssue {
      severity: 'high' | 'medium' | 'low';
      order_no: string;
      order_id: string;
      customer: string;
      sales: string;
      merchandiser: string;
      issue: string;
      action: string;
    }

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
      // 1. 缺内部单号
      if (!order.internal_order_no?.trim()) {
        issues.push({
          severity: 'medium',
          order_no: order.order_no,
          order_id: order.id,
          customer: order.customer_name || '?',
          sales: salesName,
          merchandiser: merchName,
          issue: '缺内部单号',
          action: '请业务补填内部订单号（订单册编号）',
        });
      }

      // 2. 缺工厂
      if (!order.factory_name?.trim()) {
        issues.push({
          severity: 'high',
          order_no: order.order_no,
          order_id: order.id,
          customer: order.customer_name || '?',
          sales: salesName,
          merchandiser: merchName,
          issue: '未指定工厂',
          action: '请跟单确认生产工厂',
        });
      }

      // 3. 缺跟单负责人
      if (!order.owner_user_id) {
        issues.push({
          severity: 'high',
          order_no: order.order_no,
          order_id: order.id,
          customer: order.customer_name || '?',
          sales: salesName,
          merchandiser: merchName,
          issue: '未指定跟单负责人',
          action: '请生产主管指派跟单',
        });
      }

      // 4. 数量异常
      if (!order.quantity || order.quantity <= 0) {
        issues.push({
          severity: 'high',
          order_no: order.order_no,
          order_id: order.id,
          customer: order.customer_name || '?',
          sales: salesName,
          merchandiser: merchName,
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
            severity: 'high',
            order_no: order.order_no,
            order_id: order.id,
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
            severity: 'medium',
            order_no: order.order_no,
            order_id: order.id,
            issue: `${daysSinceUpdate} 天未更新`,
            action: '请确认订单是否还在进行',
          });
        }
      }
    }

    // 7. 查逾期节点
    const { data: overdueMilestones } = await supabase
      .from('milestones')
      .select('id, name, owner_role, due_at, order_id, orders!inner(order_no)')
      .in('status', ['in_progress', '进行中'])
      .lt('due_at', today + 'T00:00:00');

    const overdueByOrder: Record<string, number> = {};
    for (const ms of (overdueMilestones || []) as any[]) {
      const orderNo = ms.orders?.order_no || '?';
      overdueByOrder[orderNo] = (overdueByOrder[orderNo] || 0) + 1;
    }

    for (const [orderNo, count] of Object.entries(overdueByOrder)) {
      if (count >= 3) {
        issues.push({
          severity: 'high',
          order_no: orderNo,
          order_id: '',
          issue: `${count} 个节点逾期未处理`,
          action: '请相关负责人立即跟进',
        });
      }
    }

    // 发通知给管理员
    if (issues.length > 0) {
      const highCount = issues.filter(i => i.severity === 'high').length;
      const mediumCount = issues.filter(i => i.severity === 'medium').length;

      const summary = issues.slice(0, 10).map(i =>
        `[${i.severity === 'high' ? '🔴' : '🟡'}] ${i.order_no}: ${i.issue}`
      ).join('\n');

      // 通知所有 admin
      const { data: admins } = await supabase
        .from('profiles')
        .select('user_id')
        .or("role.eq.admin,roles.cs.{admin}");

      for (const admin of (admins || []) as any[]) {
        await supabase.from('notifications').insert({
          user_id: admin.user_id,
          type: 'daily_audit',
          title: `📋 每日审计：${highCount} 个严重问题，${mediumCount} 个需关注`,
          message: `扫描 ${orders.length} 个订单，发现 ${issues.length} 个问题：\n${summary}${issues.length > 10 ? `\n...还有 ${issues.length - 10} 个问题` : ''}`,
          status: 'unread',
        });
      }
    }

    return NextResponse.json({
      success: true,
      orders_scanned: orders.length,
      issues_found: issues.length,
      high: issues.filter(i => i.severity === 'high').length,
      medium: issues.filter(i => i.severity === 'medium').length,
      details: issues,
    });
  } catch (err: any) {
    console.error('[order-audit]', err?.message);
    return NextResponse.json({ error: err?.message }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return POST(req);
}
