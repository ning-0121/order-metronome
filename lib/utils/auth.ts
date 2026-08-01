import { EMAIL_DOMAIN_SUFFIX, isTenantEmail } from '@/lib/config/brand';

export function isAllowedEmailDomain(email: string): boolean {
  return isTenantEmail(email);
}

export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

export function validateEmail(email: string): { valid: boolean; error?: string } {
  if (!email) {
    return { valid: false, error: '请输入邮箱地址' };
  }
  if (!isValidEmail(email)) {
    return { valid: false, error: '邮箱格式不正确' };
  }
  if (!isAllowedEmailDomain(email)) {
    return { valid: false, error: `仅允许 ${EMAIL_DOMAIN_SUFFIX} 邮箱登录` };
  }
  return { valid: true };
}
