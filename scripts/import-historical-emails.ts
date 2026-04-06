/**
 * 历史邮件批量导入脚本
 *
 * 通过 IMAP 连接腾讯企业邮箱，读取过去 N 天的邮件，
 * 发送到系统 /api/mail-inbox 接口。
 *
 * 使用方法：
 *   1. 安装依赖：npm install imapflow
 *   2. 配置下方的 ACCOUNTS 数组（每个业务员的邮箱+密码）
 *   3. 配置 API_URL 和 API_SECRET
 *   4. 运行：npx tsx scripts/import-historical-emails.ts
 *
 * 注意：
 * - 这个脚本在本地运行，不在 Vercel 上
 * - 每个邮箱大约需要 1-5 分钟（取决于邮件数量）
 * - 只读取邮件，不会修改/删除邮件
 */

// ═══ 配置区 ═══

const API_URL = 'https://order.qimoactivewear.com/api/mail-inbox';
const API_SECRET = ''; // 填写 MAIL_INTAKE_SECRET 环境变量的值

const DAYS_TO_IMPORT = 90; // 导入过去多少天的邮件

// 每个业务员的邮箱配置
const ACCOUNTS = [
  // { email: 'winnie@qimoclothing.com', password: '密码' },
  // { email: 'vivi@qimoclothing.com', password: '密码' },
  // 添加所有需要导入的业务员邮箱...
];

// ═══ 导入逻辑 ═══

async function importEmails() {
  if (ACCOUNTS.length === 0) {
    console.error('❌ 请先在 ACCOUNTS 数组中配置业务员邮箱和密码');
    process.exit(1);
  }
  if (!API_SECRET) {
    console.error('❌ 请填写 API_SECRET（与 Vercel 环境变量 MAIL_INTAKE_SECRET 一致）');
    process.exit(1);
  }

  let totalImported = 0;
  let totalFailed = 0;

  for (const account of ACCOUNTS) {
    console.log(`\n📧 处理邮箱: ${account.email}`);

    try {
      // 动态导入 imapflow（需要先 npm install imapflow）
      const { ImapFlow } = await import('imapflow');

      const client = new ImapFlow({
        host: 'imap.exmail.qq.com',
        port: 993,
        secure: true,
        auth: { user: account.email, pass: account.password },
        logger: false,
      });

      await client.connect();
      console.log(`  ✅ 连接成功`);

      // 打开收件箱
      const lock = await client.getMailboxLock('INBOX');

      try {
        // 搜索过去 N 天的邮件
        const since = new Date(Date.now() - DAYS_TO_IMPORT * 86400000);
        const sinceStr = since.toISOString().slice(0, 10);

        console.log(`  📅 搜索 ${sinceStr} 之后的邮件...`);

        const messages = client.fetch(
          { since: since },
          { envelope: true, bodyStructure: true, source: true }
        );

        let count = 0;
        for await (const msg of messages) {
          const envelope = msg.envelope;
          if (!envelope) continue;

          const from = envelope.from?.[0]?.address || '';
          const subject = envelope.subject || '';
          const date = envelope.date?.toISOString() || new Date().toISOString();

          // 跳过系统邮件和通知邮件
          if (from.includes('noreply') || from.includes('notification') || from.includes('mailer-daemon')) continue;
          // 跳过内部邮件（同域名）
          if (from.endsWith('@qimoclothing.com')) continue;

          // 提取邮件正文（简单提取，不处理附件）
          let body = '';
          if (msg.source) {
            const sourceStr = msg.source.toString();
            // 简单提取文本部分
            const textMatch = sourceStr.match(/Content-Type: text\/plain[\s\S]*?\n\n([\s\S]*?)(?=\n--|\n\.)/);
            if (textMatch) body = textMatch[1].slice(0, 5000);
            else body = subject; // fallback
          }

          // 发送到系统 API
          try {
            const res = await fetch(API_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_SECRET}`,
              },
              body: JSON.stringify({
                from_email: from,
                subject: subject,
                raw_body: body,
                received_at: date,
              }),
            });

            if (res.ok) {
              totalImported++;
              count++;
            } else {
              totalFailed++;
              const err = await res.text();
              if (count < 3) console.log(`  ⚠ 导入失败: ${subject.slice(0, 50)} — ${err}`);
            }
          } catch (fetchErr: any) {
            totalFailed++;
          }

          // 每100封显示进度
          if (count % 100 === 0 && count > 0) {
            console.log(`  📊 已处理 ${count} 封...`);
          }
        }

        console.log(`  📊 ${account.email}: 导入 ${count} 封邮件`);
      } finally {
        lock.release();
      }

      await client.logout();
    } catch (err: any) {
      console.error(`  ❌ ${account.email} 失败: ${err.message}`);
    }
  }

  console.log(`\n${'═'.repeat(40)}`);
  console.log(`✅ 导入完成: ${totalImported} 封成功, ${totalFailed} 封失败`);
  console.log(`${'═'.repeat(40)}`);
}

importEmails().catch(console.error);
