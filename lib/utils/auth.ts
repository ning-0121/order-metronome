export function isAllowedEmailDomain(email: string): boolean {
  return email.toLowerCase().endsWith('@qimoclothing.com');
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
    return { valid: false, error: '仅允许 @qimoclothing.com 邮箱登录' };
  }
  return { valid: true };
}
