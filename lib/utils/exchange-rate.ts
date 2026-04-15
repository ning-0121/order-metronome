/**
 * 实时汇率获取（带1小时缓存）
 *
 * 优先：从环境变量手动设置的汇率
 * 其次：从免费API获取实时汇率
 * 兜底：7.2（硬编码安全值）
 */

let cachedRate: { rate: number; fetchedAt: number } | null = null;
const CACHE_TTL = 60 * 60 * 1000; // 1小时缓存

/**
 * 获取 USD → RMB 汇率
 * 优先级：环境变量 > API > 缓存 > 7.2
 */
export async function getUsdToRmbRate(): Promise<number> {
  // 1. 环境变量手动设置（CEO可随时调整）
  const envRate = process.env.USD_RMB_RATE;
  if (envRate) {
    const parsed = parseFloat(envRate);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  // 2. 缓存未过期
  if (cachedRate && Date.now() - cachedRate.fetchedAt < CACHE_TTL) {
    return cachedRate.rate;
  }

  // 3. 从免费API获取
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(
      'https://open.er-api.com/v6/latest/USD',
      { signal: controller.signal, next: { revalidate: 3600 } }
    );
    clearTimeout(timeout);

    if (res.ok) {
      const data = await res.json();
      const rate = data?.rates?.CNY;
      if (rate && typeof rate === 'number' && rate > 5 && rate < 10) {
        cachedRate = { rate, fetchedAt: Date.now() };
        return rate;
      }
    }
  } catch {
    // API失败，用缓存或兜底
  }

  // 4. 兜底
  return cachedRate?.rate || 7.2;
}

/**
 * 获取任意货币 → RMB 汇率
 */
export async function getCurrencyToRmbRate(currency: string): Promise<number> {
  const c = (currency || 'USD').toUpperCase();
  if (c === 'RMB' || c === 'CNY') return 1;
  if (c === 'USD') return getUsdToRmbRate();

  // 其他货币：先转USD再转RMB
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(
      `https://open.er-api.com/v6/latest/${c}`,
      { signal: controller.signal }
    );
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      const cnyRate = data?.rates?.CNY;
      if (cnyRate && typeof cnyRate === 'number') {
        return cnyRate;
      }
    }
  } catch {}

  // 兜底：常见汇率
  const fallbacks: Record<string, number> = {
    EUR: 7.8, GBP: 9.1, JPY: 0.048, AUD: 4.7, CAD: 5.3, HKD: 0.92,
  };
  return fallbacks[c] || 7.2;
}
