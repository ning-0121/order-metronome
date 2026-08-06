/**
 * 通知保留期(2026-08-05)。
 *
 * 【为什么要有这个】
 * 系统建库以来 notifications 表**只进不出**,从来没有任何清理。
 * 2026-08-05 体检时:53,543 条 / 31 MB,是全库最大的表。其中
 *   · 46,092 条(86%)是 `chain_alert` —— 2026-04-07~04-28 三周内刷出来的,
 *     生成它的功能后来被删了,**代码库里现在零引用**,纯死数据。
 *   · 未读 25,997 条,方园 6,290 / Winnie 6,141 / 王海莲 5,577 ——
 *     铃铛红点四位数,点开是一堵墙,于是**没人再看通知**。
 *     通知系统失效不是因为不好用,是因为没人清过。
 *
 * 死数据已一次性清掉(索引 10 MB → 1.2 MB)。但一次性清理只解决当下:
 * 只要没有保留期,下一个刷屏的功能会把它再撑回去。所以把清理变成每晚例行。
 *
 * 【两段式老化】
 *   ① 90 天仍未读 → 标已读。90 天没人看的通知不会再有人处理了,
 *      留着只是把红点变成噪音,反而淹掉真正要办的事。标已读而不是直接删 ——
 *      记录再留 90 天,万一要回查还在。
 *   ② 已读满 180 天 → 删。通知是**投递通道,不是审计日志** ——
 *      谁在什么时候做了什么,真相在 milestone_logs / order_logs / runtime_events,
 *      那几张表一条都不动。删通知不丢任何审计能力。
 *
 * 顺序必须是先 ① 后 ②:反过来的话当晚标已读的会被同一轮立刻删掉,
 * 「再留 90 天」就成了空话。
 *
 * 【顺带的哨兵】
 * 4 月那次刷屏之所以撑到 8 月才被发现,是因为没人盯这张表。
 * 清完之后如果还超过 FLOOD_THRESHOLD,说明有东西在刷 —— 直接报给 admin,
 * 别再等四个月。
 */

export const RETENTION = {
  /** 未读超过这么多天 → 标已读(清红点) */
  MARK_READ_AFTER_DAYS: 90,
  /** 已读超过这么多天 → 删除 */
  DELETE_READ_AFTER_DAYS: 180,
  /** 清理后仍超过这个量级 = 有东西在刷屏,报 admin */
  FLOOD_THRESHOLD: 20000,
} as const;

export interface RetentionResult {
  markedRead: number;
  deleted: number;
  remaining: number;
  flooding: boolean;
  /** 刷屏时的类型排行,直接告诉 admin 是谁在刷 */
  topTypes: Array<{ type: string; count: number }>;
  errors: string[];
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString();

/** 数一下(head+count,不拉数据) */
async function countBy(supabase: any, build: (q: any) => any): Promise<number> {
  const { count, error } = await build(
    supabase.from('notifications').select('*', { count: 'exact', head: true }),
  );
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * 跑一轮通知保留期。service-role 客户端调用。
 * 失败不抛 —— 这是夜间维护的一步,不能因为清理失败把整个维护任务带崩。
 */
export async function runNotificationRetention(supabase: any): Promise<RetentionResult> {
  const r: RetentionResult = {
    markedRead: 0, deleted: 0, remaining: 0, flooding: false, topTypes: [], errors: [],
  };

  // ① 未读满 90 天 → 标已读
  try {
    const cutoff = daysAgo(RETENTION.MARK_READ_AFTER_DAYS);
    r.markedRead = await countBy(supabase, (q: any) => q.eq('status', 'unread').lt('created_at', cutoff));
    if (r.markedRead > 0) {
      const { error } = await (supabase.from('notifications') as any)
        .update({ status: 'read' }).eq('status', 'unread').lt('created_at', cutoff);
      if (error) throw new Error(error.message);
    }
  } catch (e: any) {
    r.markedRead = 0;
    r.errors.push(`标已读失败: ${e?.message}`);
  }

  // ② 已读满 180 天 → 删除(必须在 ① 之后,理由见文件头)
  try {
    const cutoff = daysAgo(RETENTION.DELETE_READ_AFTER_DAYS);
    r.deleted = await countBy(supabase, (q: any) => q.eq('status', 'read').lt('created_at', cutoff));
    if (r.deleted > 0) {
      const { error } = await (supabase.from('notifications') as any)
        .delete().eq('status', 'read').lt('created_at', cutoff);
      if (error) throw new Error(error.message);
    }
  } catch (e: any) {
    r.deleted = 0;
    r.errors.push(`删除失败: ${e?.message}`);
  }

  // ③ 哨兵
  try {
    r.remaining = await countBy(supabase, (q: any) => q);
    r.flooding = r.remaining > RETENTION.FLOOD_THRESHOLD;
    if (r.flooding) {
      // 只在刷屏时才翻页统计类型 —— 平时不值得为它扫全表
      const tally = new Map<string, number>();
      for (let from = 0; ; from += 1000) {
        const { data, error } = await supabase
          .from('notifications').select('type').range(from, from + 999);
        if (error) throw new Error(error.message);
        const rows = data || [];
        for (const x of rows) tally.set(x.type || '(空)', (tally.get(x.type || '(空)') || 0) + 1);
        if (rows.length < 1000) break;
      }
      r.topTypes = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 5)
        .map(([type, count]) => ({ type, count }));
    }
  } catch (e: any) {
    r.errors.push(`统计失败: ${e?.message}`);
  }

  return r;
}

/** 人话摘要,给 admin 通知用 */
export function formatRetentionResult(r: RetentionResult): string {
  const parts = [`通知清理:标已读 ${r.markedRead} · 删除 ${r.deleted} · 剩余 ${r.remaining}`];
  if (r.flooding) {
    parts.push(
      `⚠️ 通知量仍超 ${RETENTION.FLOOD_THRESHOLD} —— 疑似有功能在刷屏。` +
      `类型排行:${r.topTypes.map((t) => `${t.type} ${t.count}`).join(' / ')}`,
    );
  }
  if (r.errors.length) parts.push(`错误:${r.errors.join(';')}`);
  return parts.join('\n');
}
