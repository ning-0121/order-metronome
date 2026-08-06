/**
 * 请求级鉴权缓存 —— vitest 里能锁住的部分。
 *
 * 背景(2026-08-05):全站 561 处 auth.getUser(),每次都是一个真实网络往返;
 * 订单详情页一次加载验 4 次身份 + 查 4 次同样的 profiles。
 * 修法:createClient 包 React cache()(请求级单例)+ getUser 在实例上做单飞 memo。
 *
 * ⚠️ vitest 加载的是 React 客户端构建,它的 cache() 是纯透传 —— 所以
 * 「同一请求内单例」这条在这里测不了,权威验证在真实 RSC 运行时做过:
 *   · 同请求 createClient 两次 === 同一实例;getUser 两次 === 同一个 Promise;
 *     getCurrentUserRole 两次 === 同一个结果对象(引用相等)
 *   · 换 cookie 的请求各自独立(A 拿 AAA、B 拿 BBB,零串号)
 * 这里锁的是**不依赖 React cache 的两条**:
 *   1. getUser 的实例级 memo(挂在实例上,与 RSC 无关)
 *   2. 无请求作用域时 cache() 透传 → 每次新实例(cron/脚本的安全保证)
 */
import { describe, it, expect, vi } from 'vitest';

// 不打真库(所有断言都是引用比较,不发请求),给个占位配置即可
process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'placeholder-key';

vi.mock('next/headers', () => ({
  cookies: async () => ({ getAll: () => [], get: () => undefined, set: () => {} }),
}));

describe('请求级鉴权缓存', () => {
  it('同一实例上 getUser() 是单飞:两次调用返回同一个 Promise', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const c: any = await createClient();
    const p1 = c.auth.getUser();
    const p2 = c.auth.getUser();
    expect(p1).toBe(p2);
  });

  it('带 jwt 参数的 getUser(jwt) 不走 memo —— 校验别人的 token 不能吃缓存', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const c: any = await createClient();
    const p1 = c.auth.getUser('some-jwt');
    const p2 = c.auth.getUser('some-jwt');
    expect(p1).not.toBe(p2);
    await Promise.allSettled([p1, p2]);   // 别留悬空 rejection
  });

  it('无请求作用域(cron/脚本):每次 createClient 都是新实例,行为与从前一致', async () => {
    const { createClient } = await import('@/lib/supabase/server');
    const c1: any = await createClient();
    const c2: any = await createClient();
    expect(c1).not.toBe(c2);
  });
});
