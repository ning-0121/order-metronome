/**
 * 品牌单一真相源(L1,2026-08-01)。
 *
 * 背景:全库有 283 处品牌痕迹散在 95 个文件里 —— 产品名、法人抬头、邮箱域、站点域各写各的。
 * 只要哪天要给第二家客户用,就得满仓库 grep 中文公司名,漏一处就是客户在自己的 PI 上看见「绮陌」。
 *
 * 这里把它们收成一处。**默认值就是绮陌现在的值,所以本次不改变任何线上行为**;
 * 换客户时只动 env,不动代码。
 *
 * ⚠️ 两条纪律:
 * 1. 本文件是**纯常量模块,绝不能加 'use server'** —— 那种文件只允许导出 async 函数,
 *    导出常量能过 build 但运行时打挂整个 action chunk(见 [[use-server-export-guard]] 的教训)。
 * 2. 客户端组件(如 app/login/page.tsx)也要读品牌,所以对外暴露的 env 一律走 NEXT_PUBLIC_ 前缀。
 *    Next.js 在构建期做字面量替换,`process.env.NEXT_PUBLIC_X` 必须整段写死、不能动态拼。
 *
 * 不在本模块管辖范围:代码标识符(QimoKpiCard / QimoAIGateway 等 63 处)。
 * 那些是类名和组件名,不是品牌展示,改了纯属制造 diff。
 */

const env = (v: string | undefined, fallback: string) => {
  const s = (v ?? '').trim();
  return s === '' ? fallback : s;
};

export const BRAND = {
  /** 产品名,出现在页脚、邮件标题、导出文件抬头 */
  productName: env(process.env.NEXT_PUBLIC_BRAND_PRODUCT_NAME, 'QIMO OS'),

  /** 法人全称(中文)—— 采购单、收货单、生产任务单的落款主体 */
  legalNameZh: env(process.env.NEXT_PUBLIC_BRAND_LEGAL_NAME_ZH, '义乌市绮陌服饰有限公司'),

  /** 法人全称(英文)—— 报价单、PI、出口单据抬头 */
  legalNameEn: env(process.env.NEXT_PUBLIC_BRAND_LEGAL_NAME_EN, 'QIMO CLOTHING CO., LTD'),

  /** 简称(中文),正文里提到公司时用 */
  shortNameZh: env(process.env.NEXT_PUBLIC_BRAND_SHORT_NAME_ZH, '绮陌'),

  /** 技术主体署名,邮件落款用 */
  techNameZh: env(process.env.NEXT_PUBLIC_BRAND_TECH_NAME_ZH, '绮陌科技'),

  /** 允许登录的邮箱域(不含 @)。商用换客户时**这一项是硬阻塞**,必须先改。 */
  emailDomain: env(process.env.NEXT_PUBLIC_BRAND_EMAIL_DOMAIN, 'qimoclothing.com'),

  /** 线上站点域,出现在邮件正文和页脚的「访问 xxx」 */
  siteDomain: env(process.env.NEXT_PUBLIC_BRAND_SITE_DOMAIN, 'order.qimoactivewear.com'),
} as const;

/** `@qimoclothing.com` —— 带 @ 的登录域,拼字符串时别再手写 */
export const EMAIL_DOMAIN_SUFFIX = `@${BRAND.emailDomain}`;

/** 邮箱是否属于本租户 */
export function isTenantEmail(email: string | null | undefined): boolean {
  return !!email && email.toLowerCase().endsWith(EMAIL_DOMAIN_SUFFIX);
}

/**
 * 管理员白名单。
 * 之前硬编码在 lib/utils/user-role.ts 和 lib/utils/admin-route-guard.ts 两处 ——
 * 两份名单各自维护,改一处漏一处就是权限口子。收到这里,并允许 env 覆盖。
 *
 * 注意:这是**授权边界**,只读 server-side env(不带 NEXT_PUBLIC_),不让它进客户端 bundle。
 */
export const ADMIN_EMAILS: readonly string[] = (() => {
  const raw = (process.env.ADMIN_EMAILS ?? '').trim();
  if (raw) return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return [`alex@${BRAND.emailDomain}`, `su@${BRAND.emailDomain}`];
})();

export function isAdminEmail(email: string | null | undefined): boolean {
  return !!email && ADMIN_EMAILS.includes(email.toLowerCase());
}
