/**
 * Check if email domain is allowed (@qimoclothing.com)
 */
export function isAllowedEmailDomain(email: string): boolean {
  const allowedDomain = '@qimoclothing.com';
  return email.toLowerCase().endsWith(allowedDomain);
}

/**
 * Validate email format
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate email and domain
 */
export function validateEmail(email: string): { valid: boolean; error?: string } {
  if (!email) {
    return { valid: false, error: 'Email is required' };
  }
  
  if (!isValidEmail(email)) {
    return { valid: false, error: 'Invalid email format' };
  }
  
  if (!isAllowedEmailDomain(email)) {
    return { valid: false, error: 'Only @qimoclothing.com email addresses are allowed' };
  }
  
  return { valid: true };
}
