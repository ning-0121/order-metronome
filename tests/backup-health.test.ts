/**
 * 备份健康哨兵(R1-A)—— 锁住「验产物不验动作」的口径。
 *
 * 旧备份空转数月的根因就是没人盯产物。哨兵的规则是 CEO 在 R1 里定死的:
 *   24h 无成功备份 = CRITICAL;文件 0 字节/核心表 0 行/不可解析 = FAILED。
 * 这些阈值不许被"优化"掉 —— 用测试钉住。
 */

import { describe, it, expect } from 'vitest';
import { checkBackupHealth } from '@/lib/maintenance/backup-health';

/** 假 supabase:可配置台账行 + 存储文件内容 */
function fake(opts: {
  runs?: any[]; runErr?: string;
  files?: Array<{ name: string }>; blob?: { size: number; text: string } | null; dlErr?: string;
}) {
  return {
    from() {
      return {
        select() { return this; }, eq() { return this; }, gte() { return this; },
        order() { return this; },
        limit() { return Promise.resolve(opts.runErr ? { data: null, error: { message: opts.runErr } } : { data: opts.runs || [], error: null }); },
      };
    },
    storage: {
      from() {
        return {
          list: async () => ({ data: opts.files ?? [], error: null }),
          download: async () => opts.dlErr
            ? ({ data: null, error: { message: opts.dlErr } })
            : ({ data: opts.blob ? { size: opts.blob.size, text: async () => opts.blob!.text } : null, error: null }),
        };
      },
    },
  } as any;
}

const GOOD_JSON = JSON.stringify({ tables: { orders: [{}], milestones: [{}], profiles: [{}] } });
const recentRun = [{ started_at: new Date().toISOString(), status: 'success' }];

describe('备份健康哨兵', () => {
  it('24h 无成功备份 → CRITICAL', async () => {
    const r = await checkBackupHealth(fake({ runs: [] }));
    expect(r.status).toBe('critical');
    expect(r.reason).toContain('24 小时');
  });

  it('台账说成功但存储列不到文件 → FAILED(台账也可能撒谎,以文件为准)', async () => {
    const r = await checkBackupHealth(fake({ runs: recentRun, files: [] }));
    expect(r.status).toBe('failed');
  });

  it('最新文件 0 字节级 → FAILED', async () => {
    const r = await checkBackupHealth(fake({ runs: recentRun, files: [{ name: '2026-08-07_18-00-00.json' }], blob: { size: 12, text: '{}' } }));
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('字节');
  });

  it('核心表 0 行 → FAILED', async () => {
    const empty = JSON.stringify({ tables: { orders: [], milestones: [{}], profiles: [{}] } });
    const r = await checkBackupHealth(fake({ runs: recentRun, files: [{ name: 'x.json' }], blob: { size: 200_000, text: empty } }));
    expect(r.status).toBe('failed');
    expect(r.reason).toContain('orders');
  });

  it('全部达标 → healthy', async () => {
    const r = await checkBackupHealth(fake({ runs: recentRun, files: [{ name: 'x.json' }], blob: { size: 200_000, text: GOOD_JSON } }));
    expect(r.status).toBe('healthy');
  });
});
