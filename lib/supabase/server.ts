import { createServerClient } from '@supabase/ssr';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { Database } from './database.types';

/**
 * 请求级缓存(2026-08-05 性能)。
 *
 * 【为什么】auth.getUser() 每次都发一个真实的 GET /auth/v1/user 网络往返(读过
 * auth-js 源码确认,零缓存),而生产上函数↔库单次往返中位数 58ms。全站 561 处
 * getUser() 调用点:一次订单详情页加载实测验了 4 次身份 + 查了 4 次同样的
 * profiles —— 13 次串行往返里 8 次是纯重复,约 460ms 白等。
 *
 * 【为什么安全】两层证据,不是信文档:
 * 1. React cache() 源码第一行:`if (!dispatcher) return fn.apply(null, arguments)`
 *    —— 没有请求作用域(cron/脚本)时**直接透传、完全不缓存**,行为与从前一致。
 * 2. 实测(临时探针页,已删):同一请求内两次调用只执行一次;换 cookie 的请求
 *    各自重新执行 —— A 拿 AAA、B 拿 BBB、无 cookie 拿 none,零串号。
 *
 * 【getUser 的 memo 为什么挂在实例上】561 处调用点都是 supabase.auth.getUser(),
 * 改调用点不现实。实例本身被 cache() 限定为请求级,挂在实例上的 memo 自然也是
 * 请求级 —— 请求结束实例被丢弃,memo 一起消失。
 * 带 jwt 参数的调用不走 memo(那是校验别人的 token,不是"当前用户是谁")。
 *
 * 【核对过的边界】signOut() 后必 redirect(跳出本请求);signInWithPassword 后
 * 无后续 getUser;全库不存在「同一请求内改身份再读身份」的链路。
 */
export const createClient = cache(async () => {
  const cookieStore = await cookies();

  const client = createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // The `setAll` method was called from a Server Component.
            // This can be ignored if you have middleware refreshing
            // user sessions.
          }
        },
      },
    }
  );

  // 同一请求内,无参 getUser() 只发一次网络请求(见文件头)。
  // ⚠️ 失败不能被缓存:原来 4 路独立调用,1 路网络抖动其余 3 路还能成功;
  //    单飞后如果把一次瞬时失败钉进 memo,整个请求内所有权限检查跟着全挂。
  //    所以拿到 error(或 reject)就清掉 memo,让同请求内的下一个调用方重试。
  const origGetUser = client.auth.getUser.bind(client.auth);
  let memo: ReturnType<typeof origGetUser> | null = null;
  client.auth.getUser = ((jwt?: string) => {
    if (jwt) return origGetUser(jwt);
    if (!memo) {
      memo = origGetUser().then(
        (r) => { if ((r as any)?.error) memo = null; return r; },
        (err) => { memo = null; throw err; },
      ) as ReturnType<typeof origGetUser>;
    }
    return memo;
  }) as typeof client.auth.getUser;

  return client;
});

/**
 * Service role client (bypasses RLS). Use only in trusted server contexts (e.g. mail ingest webhook).
 * Requires SUPABASE_SERVICE_ROLE_KEY in env.
 */
export function createServiceRoleClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY (and URL) required for service role client');
  return createSupabaseClient<Database>(url, key);
}
