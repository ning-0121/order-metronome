/**
 * 品牌配置回归锁(L1,2026-08-01)。
 *
 * lib/config/brand.ts 把散在 95 个文件里的品牌串收成一处,顺带把**登录域门禁**和
 * **管理员白名单**也收了进去。这两项是授权边界:默认值只要被谁顺手改一下,
 * 线上就是"全公司登不进去"或者"管理员没了"。
 *
 * 所以这里锁的不是"配置能读出来",而是**默认值必须仍然等于绮陌线上现值**。
 */
import { describe, it, expect } from 'vitest';
import { BRAND, EMAIL_DOMAIN_SUFFIX, ADMIN_EMAILS, isTenantEmail, isAdminEmail } from '@/lib/config/brand';

describe('品牌配置默认值 = 绮陌线上现值', () => {
  it('登录域没被改动', () => {
    expect(BRAND.emailDomain).toBe('qimoclothing.com');
    expect(EMAIL_DOMAIN_SUFFIX).toBe('@qimoclothing.com');
  });

  it('对外展示的抬头没被改动', () => {
    expect(BRAND.productName).toBe('QIMO OS');
    expect(BRAND.legalNameZh).toBe('义乌市绮陌服饰有限公司');
    // 报关抬头,带 YIWU 前缀。全库四处(报价单/PI/装箱单/EXPORT_SELLER)都是这个。
    expect(BRAND.legalNameEn).toBe('YIWU QIMO CLOTHING CO.,LTD');
    expect(BRAND.siteDomain).toBe('order.qimoactivewear.com');
  });

  it('管理员白名单仍是那两个人(此前分散在 user-role 和 admin-route-guard 两份副本)', () => {
    expect([...ADMIN_EMAILS].sort()).toEqual(['alex@qimoclothing.com', 'su@qimoclothing.com']);
  });
});

describe('单据抬头收口后逐字不变', () => {
  // PI 抬头此前在 order-pi.ts 和 shipping-doc-builders.ts 各存一份副本,2026-08-01 合并成一份。
  // 这是报关/发票上的字,合并时错一个字符都是事故 —— 逐字锁死合并前的原值。
  it('PI_ISSUER 与合并前逐字相同', async () => {
    const { PI_ISSUER } = await import('@/lib/domain/document-templates');
    expect(PI_ISSUER.company).toBe('YIWU QIMO CLOTHING CO.,LTD（义乌市绮陌服饰有限公司）');
    expect(PI_ISSUER.address).toBe('2108 Room, Global Building, No.168 Financial 6th Street, Yiwu City, Zhejiang Province, China');
    expect(PI_ISSUER.contact).toBe('CONTACT: ALEX QIN    TEL: 86-15924281155    FAX: 0579-81548728    EMAIL: ALEX@QIMOCLOTHING.COM');
    expect(PI_ISSUER.title).toBe('PROFORMA INVOICE');
  });

  it('EXPORT_SELLER 出口抬头与收口前逐字相同', async () => {
    const { EXPORT_SELLER } = await import('@/lib/domain/document-templates');
    expect(EXPORT_SELLER.name_cn).toBe('义乌市绮陌服饰有限公司');
    expect(EXPORT_SELLER.name_en).toBe('YIWU QIMO CLOTHING CO.,LTD');
    expect(EXPORT_SELLER.email).toBe('alex@qimoclothing.com');
  });

  it('广州主体没被误并进义乌主体(两个法人,不是重复)', async () => {
    const { COMPANY_INFO, EXPORT_SELLER } = await import('@/lib/domain/document-templates');
    expect(COMPANY_INFO.name).toBe('绮陌服饰科技（广州）有限公司');
    expect(COMPANY_INFO.name).not.toBe(EXPORT_SELLER.name_cn);
  });
});

describe('门禁行为与收口前一致', () => {
  it('本域邮箱放行,外域拒绝', () => {
    expect(isTenantEmail('alex@qimoclothing.com')).toBe(true);
    expect(isTenantEmail('ALEX@QIMOCLOTHING.COM')).toBe(true);   // 大小写不敏感
    expect(isTenantEmail('someone@gmail.com')).toBe(false);
    expect(isTenantEmail('')).toBe(false);
    expect(isTenantEmail(null)).toBe(false);
    expect(isTenantEmail(undefined)).toBe(false);
  });

  it('不能靠后缀伪装混进来', () => {
    // 收口前用的是 endsWith('@qimoclothing.com'),这几种必须仍然被拒
    expect(isTenantEmail('evil@notqimoclothing.com')).toBe(false);
    expect(isTenantEmail('qimoclothing.com')).toBe(false);        // 没有 @
    expect(isTenantEmail('a@qimoclothing.com.evil.com')).toBe(false);
  });

  it('管理员判定大小写不敏感,非白名单一律不是管理员', () => {
    expect(isAdminEmail('Alex@Qimoclothing.com')).toBe(true);
    expect(isAdminEmail('su@qimoclothing.com')).toBe(true);
    expect(isAdminEmail('other@qimoclothing.com')).toBe(false);   // 本域但不在白名单
    expect(isAdminEmail(null)).toBe(false);
  });
});
