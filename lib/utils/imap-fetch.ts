/**
 * IMAP 邮件抓取 — 腾讯企业邮箱
 *
 * 通过 IMAP 协议连接腾讯企邮，拉取未读邮件
 * 环境变量：
 *   IMAP_HOST=imap.exmail.qq.com
 *   IMAP_PORT=993
 *   IMAP_USER=orders@qimoclothing.com
 *   IMAP_PASSWORD=xxxx
 */

interface FetchedEmail {
  uid: number;
  from: string;
  subject: string;
  body: string;
  date: string;
}

/**
 * 拉取未读邮件（最近50封）
 * 使用 fetch 调用系统 API 而非直接 IMAP（Vercel 不支持长连接）
 * 所以我们用更简单的方案：通过腾讯企邮的 SMTP 转发规则
 */
export async function fetchNewEmails(): Promise<FetchedEmail[]> {
  // Vercel Serverless 不支持 IMAP 长连接
  // 方案：腾讯企邮设置"自动转发"到我们的 API
  // 或者用外部服务（如 Zapier/n8n）转发到 /api/mail-inbox

  // 这里提供一个轻量的 HTTP 方式：
  // 如果配置了 GMAIL_API_KEY（Google Apps Script webhook），
  // 可以通过 Google 中转拉取

  console.warn('[imap-fetch] Vercel 不支持直接 IMAP。请配置邮件转发到 /api/mail-inbox');
  return [];
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

  // 客户名称线索（From 字段或签名）
  const customerHints: string[] = [];

  return { poNumbers, customerHints, quantities, urgentKeywords, hasAttachment: text.includes('attachment') || text.includes('attached') };
}
