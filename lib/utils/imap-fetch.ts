/**
 * IMAP 邮件抓取 — 腾讯企业邮箱
 *
 * 短连接模式：连上 → 拉新邮件 → 断开，适合 Vercel 60秒限制
 *
 * 环境变量：
 *   IMAP_HOST=imap.exmail.qq.com
 *   IMAP_PORT=993
 *   IMAP_USER=salesrep@qimoclothing.com
 *   IMAP_PASSWORD=xxxx
 */

export interface FetchedEmail {
  uid: number;
  from: string;
  subject: string;
  body: string;
  date: string;
  messageId: string | null;
  inReplyTo: string | null;
}

/**
 * 通过 IMAP 短连接拉取最近的邮件
 * 每次拉取最近24h内的邮件（去重由调用方处理）
 */
export async function fetchNewEmails(
  maxCount = 30,
  lookbackDays = 1,
  customCredentials?: { user: string; pass: string },
): Promise<FetchedEmail[]> {
  const host = process.env.IMAP_HOST || 'imap.exmail.qq.com';
  const port = parseInt(process.env.IMAP_PORT || '993');
  const user = customCredentials?.user || process.env.IMAP_USER;
  const pass = customCredentials?.pass || process.env.IMAP_PASSWORD;

  if (!user || !pass) {
    console.warn('[imap-fetch] IMAP_USER / IMAP_PASSWORD 未配置，跳过邮件拉取');
    return [];
  }

  const emails: FetchedEmail[] = [];

  try {
    const { ImapFlow } = await import('imapflow');

    const client = new ImapFlow({
      host,
      port,
      secure: true,
      auth: { user, pass },
      logger: false,
      // 连接超时30秒（留30秒给处理）
      greetTimeout: 15000,
      socketTimeout: 30000,
    } as any);

    await client.connect();

    // 打开收件箱
    const mailbox = await client.mailboxOpen('INBOX');
    const lock = await client.getMailboxLock('INBOX');

    try {
      // 优化策略：直接按序列号取最后 N 封，跳过 search（在大邮箱里 search 极慢）
      const totalMessages = mailbox.exists || 0;
      if (totalMessages === 0) return [];

      // 取最后 maxCount 封：序列号范围 (total - maxCount + 1) : total
      const startSeq = Math.max(1, totalMessages - maxCount + 1);
      const seqRange = `${startSeq}:${totalMessages}`;

      // 拉取时按收件时间过滤（lookbackDays），只保留范围内的
      const sinceTime = Date.now() - lookbackDays * 24 * 3600000;

      for await (const msg of client.fetch(seqRange, {
        envelope: true,
        source: true,
        uid: true,
      })) {
        try {
          const envelope = msg.envelope;
          // 时间过滤：超出 lookbackDays 范围的跳过
          if (envelope?.date && envelope.date.getTime() < sinceTime) {
            continue;
          }
          const from = envelope?.from?.[0]
            ? `${envelope.from[0].name || ''} <${envelope.from[0].address || ''}>`.trim()
            : '';
          const fromEmail = envelope?.from?.[0]?.address || '';
          const subject = envelope?.subject || '';
          const date = envelope?.date?.toISOString() || new Date().toISOString();
          const messageId = envelope?.messageId || null;
          const inReplyTo = envelope?.inReplyTo || null;

          // 提取纯文本正文
          let body = '';
          if (msg.source) {
            const sourceStr = msg.source.toString('utf-8');
            body = extractPlainText(sourceStr);
          }

          emails.push({
            uid: msg.uid,
            from: fromEmail || from,
            subject,
            body: body.slice(0, 5000), // 限制正文长度
            date,
            messageId,
            inReplyTo,
          });
        } catch (parseErr) {
          // 单封邮件解析失败不影响其他
          console.error('[imap-fetch] Parse error:', parseErr);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
  } catch (err: any) {
    console.error('[imap-fetch] Connection error:', err?.message);
  }

  return emails;
}

/**
 * 从邮件原始源中提取纯文本（简易版）
 */
function extractPlainText(source: string): string {
  // 尝试找 text/plain 部分
  const plainMatch = source.match(/Content-Type:\s*text\/plain[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\.\r?\n|$)/i);
  if (plainMatch) {
    let text = plainMatch[1];
    // 处理 quoted-printable
    if (source.includes('quoted-printable')) {
      text = text.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    }
    // 处理 base64
    if (source.includes('Content-Transfer-Encoding: base64')) {
      try {
        text = Buffer.from(text.replace(/\s/g, ''), 'base64').toString('utf-8');
      } catch {}
    }
    return text.trim();
  }

  // 如果找不到 text/plain，尝试从 HTML 提取
  const htmlMatch = source.match(/Content-Type:\s*text\/html[\s\S]*?\r?\n\r?\n([\s\S]*?)(?=\r?\n--|\r?\n\.\r?\n|$)/i);
  if (htmlMatch) {
    let html = htmlMatch[1];
    if (source.includes('Content-Transfer-Encoding: base64')) {
      try { html = Buffer.from(html.replace(/\s/g, ''), 'base64').toString('utf-8'); } catch {}
    }
    // 简单去标签
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // 最后兜底：取body后面的内容
  const bodyIdx = source.indexOf('\r\n\r\n');
  if (bodyIdx > 0) {
    return source.slice(bodyIdx + 4, bodyIdx + 5004).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  return '';
}

/**
 * 解析邮件中的订单相关信息
 */
export function parseEmailForOrderInfo(subject: string, body: string): {
  poNumbers: string[];
  customerHints: string[];
  quantities: number[];
  urgentKeywords: string[];
  hasAttachment: boolean;
} {
  const text = `${subject}\n${body}`;

  // PO 号提取
  const poPatterns = [
    /PO[#:\s]*(\d{3,})/gi,
    /P\.O\.\s*(\d{3,})/gi,
    /Purchase Order[#:\s]*(\d{3,})/gi,
    /QM-\d{8}-\d{3}/gi,
  ];
  const poNumbers: string[] = [];
  for (const pattern of poPatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) poNumbers.push(m[0]);
  }

  // 数量提取
  const qtyPatterns = [
    /(\d{1,3}(?:,\d{3})+)\s*(?:pcs|pieces|件|套)/gi,
    /(\d{4,})\s*(?:pcs|pieces|件|套)/gi,
  ];
  const quantities: number[] = [];
  for (const pattern of qtyPatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const num = parseInt(m[1].replace(/,/g, ''));
      if (num > 0 && num < 10000000) quantities.push(num);
    }
  }

  // 紧急关键词
  const urgentKeywords: string[] = [];
  const urgentPatterns = ['urgent', 'asap', 'rush', '加急', '紧急', 'immediately', 'deadline'];
  for (const kw of urgentPatterns) {
    if (text.toLowerCase().includes(kw)) urgentKeywords.push(kw);
  }

  // 客户名称线索
  const customerHints: string[] = [];

  return { poNumbers, customerHints, quantities, urgentKeywords, hasAttachment: text.includes('attachment') || text.includes('attached') };
}
