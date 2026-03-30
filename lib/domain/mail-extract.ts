/**
 * Mail Intake V1 — rule-based extraction (no LLM).
 * Extracts PO number, style number, and category hints from client emails.
 */

export type MailCategoryHint = 'fabric_quality' | 'packaging' | 'plus_size_stretch';

/** Keywords for category detection (lowercase). */
export const MAIL_CATEGORY_KEYWORDS: Record<MailCategoryHint, string[]> = {
  fabric_quality: [
    'color fastness', 'fastness', 'shrinkage', 'pilling', 'staining', 'light color',
    '色牢度', '缩水', '起球', '移色', '浅色', '面料', '染色',
  ],
  packaging: [
    'packing', 'packaging', 'label', 'barcode', 'hangtag', 'carton', 'polybag', 'hanger',
    '包装', '外箱', '吊牌', '条形码', '贴标', '胶袋', '衣架',
  ],
  plus_size_stretch: [
    'plus size', 'plus-size', 'xl', '2xl', '3xl', 'stretch', 'bursting', 'seam', 'seams',
    '大码', '弹力', '爆缝', '缝制', '加肥', '宽松',
  ],
};

export interface ExtractedMail {
  extracted_po: string | null;
  extracted_style: string | null;
  categories: { category: MailCategoryHint; risk_level: 'low' | 'medium' | 'high'; quote: string }[];
}

/**
 * Extract PO number: common patterns like PO# 12345, PO: ABC-001, P/O 2024-001, 订单号 XXX
 */
function extractPo(text: string): string | null {
  const lower = text.replace(/\s+/g, ' ');
  const patterns = [
    /\bPO\s*[#:]\s*([A-Za-z0-9\-]+)/i,
    /\bP\/O\s*[#:]?\s*([A-Za-z0-9\-]+)/i,
    /\b订单号[：:]\s*([A-Za-z0-9\-]+)/,
    /\border\s*no\.?\s*[#:]\s*([A-Za-z0-9\-]+)/i,
    /\b(?:purchase\s*order|PO)\s+([A-Za-z0-9\-]{4,})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p) || lower.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/**
 * Extract style number: Style # XXX, Style: ABC-123, 款号 XXX, 款式 XXX
 */
function extractStyle(text: string): string | null {
  const patterns = [
    /\bstyle\s*[#:]\s*([A-Za-z0-9\-]+)/i,
    /\bstyle\s+no\.?\s*[#:]?\s*([A-Za-z0-9\-]+)/i,
    /\b款号[：:]\s*([A-Za-z0-9\-]+)/,
    /\b款式[：:]\s*([A-Za-z0-9\-]+)/,
    /\b(?:style|ref)\s*[#:]\s*([A-Za-z0-9\-]{3,})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return null;
}

/**
 * Find category hints and a short quote (first sentence/fragment containing keyword).
 */
function extractCategoryHints(text: string): ExtractedMail['categories'] {
  const results: ExtractedMail['categories'] = [];
  const lower = text.toLowerCase();
  const sentences = text.split(/[.!?\n。！？]/).filter(Boolean);

  for (const [category, keywords] of Object.entries(MAIL_CATEGORY_KEYWORDS) as [MailCategoryHint, string[]][]) {
    let risk_level: 'low' | 'medium' | 'high' = 'medium';
    let quote = '';

    for (const kw of keywords) {
      const idx = lower.indexOf(kw.toLowerCase());
      if (idx === -1) continue;

      // Prefer sentence containing the keyword
      for (const s of sentences) {
        if (s.toLowerCase().includes(kw.toLowerCase())) {
          quote = s.trim().slice(0, 300);
          break;
        }
      }
      if (!quote) quote = text.slice(Math.max(0, idx - 20), idx + 80).trim().slice(0, 300);

      // Risk heuristics: "must", "critical", "strict" -> high; "please" -> medium
      const fragment = (quote || text).toLowerCase();
      if (/\b(must|critical|strict|important|务必|必须|严格)\b/.test(fragment)) risk_level = 'high';
      else if (/\b(please|prefer|希望|建议)\b/.test(fragment)) risk_level = 'medium';

      results.push({ category, risk_level, quote: quote || text.slice(0, 200) });
      break; // one hint per category
    }
  }

  return results;
}

/**
 * Run all extraction on combined subject + body.
 */
export function extractFromMail(subject: string, rawBody: string): ExtractedMail {
  const combined = `${subject}\n${rawBody}`;
  const extracted_po = extractPo(combined);
  const extracted_style = extractStyle(combined);
  const categories = extractCategoryHints(combined);

  return { extracted_po, extracted_style, categories };
}
