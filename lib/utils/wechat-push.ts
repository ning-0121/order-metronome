/**
 * 企业微信通知推送
 *
 * 优先级（从高到低）：
 * 1. 企业微信群机器人 webhook（最简单，不需要 ICP 备案 / IP 白名单）
 *    → 设置 WECOM_WEBHOOK_URL 环境变量
 *    → 消息发到群里，群成员都能看到
 * 2. 企业微信应用消息（精准发送给指定员工）
 *    → 需要 WECOM_CORP_ID / WECOM_CORP_SECRET / WECOM_AGENT_ID
 *    → 需要域名 ICP 备案 + 设置可信 IP
 * 3. Server酱（向后兼容）
 *
 * 个人 wechat_push_key 字段（profiles表）：
 *   - 优先解析为企业微信 userid（如 alex/lucy）
 *   - 兼容旧 Server酱 SendKey
 */

/**
 * 通过企业微信群机器人 webhook 发送消息
 * 不需要 access_token / IP 白名单 / 域名校验，最简单的方案
 */
export async function sendWecomWebhook(
  title: string,
  content: string,
  mentionedUserIds?: string[],
): Promise<boolean> {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return false;

  try {
    // 用 markdown 格式：标题加粗，内容下面跟正文，可以 @用户
    const mentionLine = mentionedUserIds && mentionedUserIds.length > 0
      ? mentionedUserIds.map(u => `<@${u}>`).join(' ') + '\n'
      : '';

    const payload = {
      msgtype: 'markdown',
      markdown: {
        content: `${mentionLine}**${title.slice(0, 200)}**\n${content.slice(0, 1500)}`,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await res.json();
    if (json.errcode === 0) return true;
    console.warn('[WeCom Webhook] Send failed:', json.errmsg);
    return false;
  } catch (err: any) {
    console.warn('[WeCom Webhook] Error:', err?.message);
    return false;
  }
}

interface WecomTokenCache {
  token: string;
  expiresAt: number;
}

let _tokenCache: WecomTokenCache | null = null;

/**
 * 获取企业微信 access_token（带缓存）
 */
async function getWecomAccessToken(): Promise<string | null> {
  const corpId = process.env.WECOM_CORP_ID;
  const corpSecret = process.env.WECOM_CORP_SECRET;
  if (!corpId || !corpSecret) return null;

  // 缓存有效期内直接返回
  if (_tokenCache && Date.now() < _tokenCache.expiresAt) {
    return _tokenCache.token;
  }

  try {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${corpSecret}`;
    const res = await fetch(url);
    const json: any = await res.json();
    if (json.errcode === 0 && json.access_token) {
      _tokenCache = {
        token: json.access_token,
        expiresAt: Date.now() + (json.expires_in - 300) * 1000, // 提前5分钟过期
      };
      return json.access_token;
    }
    console.warn('[WeCom] Token error:', json.errmsg);
  } catch (err: any) {
    console.warn('[WeCom] Token fetch failed:', err?.message);
  }
  return null;
}

/**
 * 通过企业微信发送应用消息给指定用户
 * touser: 企业微信 userid（不是邮箱），多个用 | 分隔
 */
export async function sendWecomMessage(
  touser: string,
  title: string,
  content: string,
): Promise<boolean> {
  const corpId = process.env.WECOM_CORP_ID;
  const agentId = process.env.WECOM_AGENT_ID;
  if (!corpId || !agentId) return false;

  const token = await getWecomAccessToken();
  if (!token) return false;

  try {
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;
    const payload = {
      touser,
      msgtype: 'textcard',
      agentid: parseInt(agentId),
      textcard: {
        title: title.slice(0, 128),
        description: content.slice(0, 512),
        url: process.env.NEXT_PUBLIC_APP_URL || 'https://order.qimoactivewear.com',
        btntxt: '查看详情',
      },
    };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await res.json();
    if (json.errcode === 0) return true;
    console.warn('[WeCom] Send failed:', json.errmsg);
    return false;
  } catch (err: any) {
    console.warn('[WeCom] Send error:', err?.message);
    return false;
  }
}

/**
 * Server酱推送（向后兼容）
 */
export async function sendWechatPush(
  sendKey: string,
  title: string,
  content?: string,
): Promise<boolean> {
  if (!sendKey) return false;

  // 如果配置了企业微信，且 sendKey 看起来不是 Server酱 token（不含字母数字混合长串），
  // 优先使用企业微信
  if (process.env.WECOM_CORP_ID && !sendKey.match(/^SCT[a-zA-Z0-9]{20,}/)) {
    const ok = await sendWecomMessage(sendKey, title, content || title);
    if (ok) return true;
  }

  // 备用：Server酱
  try {
    const url = `https://sctapi.ftqq.com/${sendKey}.send`;
    const body = new URLSearchParams();
    body.append('title', title.slice(0, 100));
    if (content) body.append('desp', content.slice(0, 32000));

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
 * 批量推送：自动选择最佳通道
 *
 * 优先级：
 * 1. 群机器人 webhook（最简单，群广播 + @相关用户）
 * 2. 企业微信应用消息（需要可信域名 + IP 白名单）
 * 3. Server酱（向后兼容）
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
    .select('user_id, email, wechat_push_key, wecom_userid')
    .in('user_id', userIds);

  // ── 优先：群机器人 webhook ──
  // 一次发到群里，可以 @ 多个相关用户
  if (process.env.WECOM_WEBHOOK_URL) {
    const mentionedIds = (profiles || [])
      .map((p: any) => p.wecom_userid || p.email?.split('@')[0])
      .filter(Boolean);
    const ok = await sendWecomWebhook(title, content || title, mentionedIds);
    if (ok) return userIds.length; // 群消息算作全员送达
  }

  // ── 备选：应用消息（精准发送）──
  let sent = 0;
  const wecomAppEnabled = !!(process.env.WECOM_CORP_ID && process.env.WECOM_CORP_SECRET && process.env.WECOM_AGENT_ID);

  for (const p of profiles || []) {
    let ok = false;

    if (wecomAppEnabled) {
      if (p.wecom_userid) {
        ok = await sendWecomMessage(p.wecom_userid, title, content || title);
      }
      if (!ok && p.email) {
        const userid = p.email.split('@')[0];
        ok = await sendWecomMessage(userid, title, content || title);
      }
    }

    // 兜底：Server酱
    if (!ok && p.wechat_push_key) {
      ok = await sendWechatPush(p.wechat_push_key, title, content);
    }

    if (ok) sent++;
  }
  return sent;
}

/**
 * 向所有员工广播（用 @all）
 */
export async function broadcastToAll(title: string, content: string): Promise<boolean> {
  return sendWecomMessage('@all', title, content);
}
