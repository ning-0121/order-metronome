/**
 * Requirement classification V1.5 — rule-based, deterministic.
 * Types: risk > change > pending > confirmed > new
 */

export type RequirementType = 'risk' | 'change' | 'pending' | 'confirmed' | 'new';

export const REQUIREMENT_PRIORITY: RequirementType[] = [
  'risk',
  'change',
  'pending',
  'confirmed',
  'new',
];

const KEYWORDS: Record<Exclude<RequirementType, 'new'>, string[]> = {
  risk: [
    'high risk',
    'risk of',
    'serious issue',
    'complaint',
    'claim',
    'liability',
    '严重',
    '风险',
    '投诉',
    '索赔',
  ],
  change: [
    'change to',
    'changed to',
    'update to',
    'updated to',
    'revised',
    'modify',
    'modified',
    'different from',
    'instead of',
    '改为',
    '改成',
    '变更',
    '修改',
  ],
  pending: [
    'please confirm',
    'pls confirm',
    'could you confirm',
    'can you confirm',
    'confirm with us',
    '待确认',
    '请确认',
    '麻烦确认',
    '确认一下',
    '是否可以',
    '能否',
    // special: must be pending (not confirmed)
    'looks ok',
    'looks okay',
    'should be ok',
    'should be okay',
  ],
  confirmed: [
    'as agreed',
    'as usual',
    'same as last time',
    'same as before',
    'no change',
    'confirmed',
    'we agree',
    'we accept',
    '已确认',
    '确认采用',
    '按之前',
    '跟上次一样',
  ],
};

export interface RequirementClassification {
  type: RequirementType;
  keywordsHit: string[];
  excerpt: string;
}

/**
 * Classify a requirement text into one of 5 types, with keyword hits and an excerpt.
 * Priority: risk > change > pending > confirmed > new.
 * Special rule: any \"looks ok\" / \"should be ok\" phrase forces type=pending.
 */
export function classifyRequirement(text: string): RequirementClassification {
  const normalized = (text || '').trim();
  if (!normalized) {
    return { type: 'new', keywordsHit: [], excerpt: '' };
  }

  const lower = normalized.toLowerCase();
  const hits: Record<RequirementType, string[]> = {
    risk: [],
    change: [],
    pending: [],
    confirmed: [],
    new: [],
  };

  (Object.entries(KEYWORDS) as [Exclude<RequirementType, 'new'>, string[]][]).forEach(
    ([type, kws]) => {
      for (const kw of kws) {
        if (lower.includes(kw.toLowerCase())) {
          hits[type].push(kw);
        }
      }
    }
  );

  let finalType: RequirementType = 'new';
  for (const t of REQUIREMENT_PRIORITY) {
    if (t === 'new') continue;
    if (hits[t].length > 0) {
      finalType = t;
      break;
    }
  }

  // If nothing matched, keep 'new'
  const keywordsHit = hits[finalType];

  // Excerpt: prefer first sentence containing any keyword of finalType
  let excerpt = '';
  if (keywordsHit.length > 0) {
    const sentences = normalized.split(/[.!?\n。！？]/).filter(Boolean);
    outer: for (const s of sentences) {
      const sLower = s.toLowerCase();
      for (const kw of keywordsHit) {
        if (sLower.includes(kw.toLowerCase())) {
          excerpt = s.trim();
          break outer;
        }
      }
    }
  }

  if (!excerpt) {
    excerpt = normalized.slice(0, 200);
  } else if (excerpt.length > 200) {
    excerpt = excerpt.slice(0, 200);
  }

  return { type: finalType, keywordsHit, excerpt };
}

