/**
 * Server酱微信推送
 *
 * 文档：https://sct.ftqq.com/
 * 每人需要一个 SendKey，在 https://sct.ftqq.com/ 登录后获取
 * 存在 profiles.wechat_push_key 字段
 *
 * 免费版：每天 5 条
 * Pro版：5元/月不限量
 */

/**
 * 通过 Server酱 推送消息到个人微信
 */
export async function sendWechatPush(
  sendKey: string,
  title: string,
  content?: string,
): Promise<boolean> {
  if (!sendKey) return false;

  try {
    const url = `https://sctapi.ftqq.com/${sendKey}.send`;
    const body = new URLSearchParams();
    body.append('title', title.slice(0, 100)); // Server酱 title 限 100 字
    if (content) body.append('desp', content.slice(0, 32000)); // desp 支持 Markdown

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const json = await res.json();
    return json.code === 0 || json.errno === 0;
  } catch (err: any) {
    console.warn('[WechatPush] Failed:', err?.message);
    return false;
  }
}

/**
 * 批量推送：查询用户的 SendKey 并推送
 */
export async function pushToUsers(
  supabase: any,
  userIds: string[],
  title: string,
  content?: string,
): Promise<number> {
  if (userIds.length === 0) return 0;

  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, wechat_push_key')
    .in('user_id', userIds)
    .not('wechat_push_key', 'is', null);

  let sent = 0;
  for (const p of profiles || []) {
    if (p.wechat_push_key) {
      const ok = await sendWechatPush(p.wechat_push_key, title, content);
      if (ok) sent++;
    }
  }
  return sent;
}
