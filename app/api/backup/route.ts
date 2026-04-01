import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

/**
 * 数据备份 API — 导出关键表数据到 Supabase Storage
 *
 * 触发方式:
 * 1. Vercel Cron（每天凌晨2点自动执行）
 * 2. 管理员手动调用: POST /api/backup
 *
 * 备份内容: orders, milestones, profiles, delay_requests,
 *           order_attachments, customer_memory, ai_knowledge_base
 *
 * 存储位置: Supabase Storage -> backups bucket -> daily/{date}.json
 */

const BACKUP_TABLES = [
  'orders',
  'milestones',
  'profiles',
  'milestone_logs',
  'delay_requests',
  'order_attachments',
  'customer_memory',
  'notifications',
  'order_retrospectives',
  'order_commissions',
];

export async function POST(request: Request) {
  // 验证: Cron secret 或 管理员 session
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  const supabase = await createClient();

  // Cron 调用验证
  if (authHeader === `Bearer ${cronSecret}` && cronSecret) {
    // Cron 触发，直接执行
  } else {
    // 管理员手动触发，检查登录和角色
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: '未登录' }, { status: 401 });
    }
    const { data: profile } = await (supabase.from('profiles') as any)
      .select('role, roles').eq('user_id', user.id).single();
    const roles: string[] = profile?.roles?.length > 0 ? profile.roles : [profile?.role].filter(Boolean);
    if (!roles.includes('admin')) {
      return NextResponse.json({ error: '仅管理员可执行备份' }, { status: 403 });
    }
  }

  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // 2026-04-01
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, '-'); // 02-00-00
    const backupData: Record<string, any[]> = {};
    const stats: Record<string, number> = {};

    // 逐表导出
    for (const table of BACKUP_TABLES) {
      const { data, error } = await (supabase.from(table) as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(10000); // 安全上限

      if (error) {
        console.warn(`[backup] 表 ${table} 导出失败:`, error.message);
        backupData[table] = [];
        stats[table] = 0;
      } else {
        backupData[table] = data || [];
        stats[table] = (data || []).length;
      }
    }

    // 构建备份文件
    const backupJson = JSON.stringify({
      version: '3.2',
      created_at: now.toISOString(),
      tables: backupData,
      stats,
    });

    // 上传到 Supabase Storage
    const fileName = `daily/${dateStr}_${timeStr}.json`;
    const { error: uploadError } = await supabase.storage
      .from('backups')
      .upload(fileName, backupJson, {
        contentType: 'application/json',
        upsert: true,
      });

    if (uploadError) {
      // bucket 可能不存在，尝试创建
      if (uploadError.message.includes('not found') || uploadError.message.includes('Bucket')) {
        // Storage bucket 需要在 Supabase Dashboard 手动创建
        return NextResponse.json({
          error: '备份存储桶不存在，请在 Supabase Dashboard -> Storage 中创建名为 "backups" 的 bucket（Private）',
          stats,
        }, { status: 500 });
      }
      return NextResponse.json({ error: `备份上传失败: ${uploadError.message}`, stats }, { status: 500 });
    }

    // 清理30天前的备份（保留最近30天）
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const { data: oldFiles } = await supabase.storage.from('backups').list('daily');
    if (oldFiles) {
      const toDelete = oldFiles
        .filter(f => f.name < thirtyDaysAgo)
        .map(f => `daily/${f.name}`);
      if (toDelete.length > 0) {
        await supabase.storage.from('backups').remove(toDelete);
      }
    }

    return NextResponse.json({
      success: true,
      file: fileName,
      stats,
      totalRecords: Object.values(stats).reduce((a, b) => a + b, 0),
    });

  } catch (err: any) {
    return NextResponse.json({ error: `备份异常: ${err.message}` }, { status: 500 });
  }
}

// Vercel Cron 配置（每天凌晨2点北京时间 = UTC 18:00）
export const dynamic = 'force-dynamic';
