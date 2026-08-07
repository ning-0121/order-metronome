/**
 * QIMO Execution Integrity Layer —— R1-C(2026-08-08)。
 *
 * 最高原则:NO DATABASE CONFIRMATION = NO SUCCESS.
 *          ACTION TRIGGERED ≠ COMPLETED. COMPLETED = VERIFIED OUTCOME.
 *
 * 【为什么】体检确认的最危险模式全是同一个:
 *   动作 → DB write → 0 行/error → 代码不看 → 继续发通知/同步财务/返回成功。
 * 尤其毒的是 **RLS 过滤:UPDATE 被滤成 0 行时 PostgREST 不报 error** ——
 * 只查 error 拦不住,必须 `.select(pk)` 断言受影响行数。
 *
 * 【三层】(本文件是 Layer 1/2;Layer 3 = 各业务 Command 函数自己组装)
 *   L1 safeMutation()          普通写:error + 行数断言 + typed result
 *   L2 safeCriticalMutation()  高危写:+ before 快照 + 写后回读验证 + actor/reason 上下文
 *   L3 Business Command        approveOrderAmendment 等 —— AI/Executive OS 只许调这层,不许碰表
 *
 * 【禁止】业务层再把 `error === null` 当成功;UPDATE/DELETE 不带 .select(pk)。
 * 静态闸 scripts/check-safe-mutation.mjs 盯着 critical tables 防回潮。
 */

export type MutationStatus =
  | 'success'
  | 'db_error'
  | 'zero_rows'            // RLS 过滤/谓词不中 —— PostgREST 不报 error 的那种静默失败
  | 'row_count_mismatch'
  | 'verification_failed'  // 写后回读与期望不符
  | 'forbidden'
  | 'conflict';

export interface MutationResult<T = any> {
  ok: boolean;
  status: MutationStatus;
  data: T[] | null;
  error?: string;
  affectedRows: number;
}

export interface SafeMutationArgs {
  client: any;                       // 调用方决定 SR/S;跨用户经营写一律 SR(代码层先鉴权)
  table: string;
  operation: 'update' | 'delete' | 'insert' | 'upsert';
  payload?: Record<string, any>;
  /** 谓词:{ id: 'xxx', status: 'pending' } → .eq 逐个;并发防护把前置状态放进来 */
  predicate?: Record<string, any>;
  /** 期望受影响行数;数字=精确断言;'any'=不断言(如清理类 0 行合法) */
  expectedRows?: number | 'any';
  /** 回带字段(默认主键 id)—— UPDATE/DELETE 强制 select,这正是抓 0 行的手段 */
  selectFields?: string;
}

const PG_CONFLICT = new Set(['23505', '23503', '23514', '40001', 'P0001']);

export async function safeMutation<T = any>(args: SafeMutationArgs): Promise<MutationResult<T>> {
  const { client, table, operation, payload, predicate, selectFields = 'id' } = args;
  const expected = args.expectedRows ?? 1;
  try {
    let q: any = client.from(table);
    if (operation === 'update') q = q.update(payload);
    else if (operation === 'delete') q = q.delete();
    else if (operation === 'upsert') q = q.upsert(payload);
    else q = q.insert(payload);
    for (const [k, v] of Object.entries(predicate || {})) {
      q = v === null ? q.is(k, null) : q.eq(k, v);
    }
    // UPDATE/DELETE 默认必须回带 —— 不回带就看不见 0 行
    const { data, error } = await q.select(selectFields);

    if (error) {
      const status: MutationStatus =
        PG_CONFLICT.has(String(error.code)) ? 'conflict'
        : /permission denied|violates row-level security/i.test(String(error.message)) ? 'forbidden'
        : 'db_error';
      return { ok: false, status, data: null, error: `${error.code || ''} ${error.message}`.trim(), affectedRows: 0 };
    }
    const rows = (data || []) as T[];
    if (expected !== 'any') {
      if (rows.length === 0) {
        return { ok: false, status: 'zero_rows', data: rows, affectedRows: 0,
          error: `0 行受影响(表 ${table};典型原因:RLS 过滤/前置状态已变) —— PostgREST 对此不报 error,这就是静默失败的形态` };
      }
      if (rows.length !== expected) {
        return { ok: false, status: 'row_count_mismatch', data: rows, affectedRows: rows.length,
          error: `受影响 ${rows.length} 行 ≠ 期望 ${expected} 行(表 ${table})` };
      }
    }
    return { ok: true, status: 'success', data: rows, affectedRows: rows.length };
  } catch (e: any) {
    return { ok: false, status: 'db_error', data: null, error: e?.message || String(e), affectedRows: 0 };
  }
}

// ─────────────────────────────────────────────────────────────────────

export interface CriticalContext {
  actor: string;                    // user_id / 'system'
  reason: string;                   // 业务理由(改单号/延期单号…)
  riskLevel: 'money' | 'delivery' | 'permission';
  decisionId?: string;              // 审批单/申请单 id
  /** 写后回读断言:期望这些字段等于这些值(不给则回读仅确认行存在) */
  verifyFields?: Record<string, any>;
  /** 快照字段(before/after 进审计 payload);默认 = payload 的键 */
  snapshotFields?: string[];
}

export interface CriticalMutationResult<T = any> extends MutationResult<T> {
  before?: Record<string, any> | null;
  after?: Record<string, any> | null;
}

/**
 * 高危写:改价/改量/延期锚点/生命周期/财务状态/权限字段专用。
 * 流程钉死:①读 before 快照 → ②写(断言行数) → ③回读验证 → ④审计留痕(现有 order_logs 能力,
 * R1-D 会收口成 writeAuditEvent;审计失败记 console+返回体,不阻断已验证的主写)。
 * **只有全部通过,调用方才允许执行副作用/发通知。**
 */
export async function safeCriticalMutation<T = any>(
  args: SafeMutationArgs & { ctx: CriticalContext; auditOrderId?: string | null },
): Promise<CriticalMutationResult<T>> {
  const { client, table, payload, predicate, ctx } = args;
  const snapFields = ctx.snapshotFields || Object.keys(payload || {});
  const pk = (predicate as any)?.id;

  // ① before 快照(拿不到 = 目标行不存在/不可见,直接失败,绝不盲写)
  let before: Record<string, any> | null = null;
  if (pk) {
    const { data: b, error: bErr } = await client.from(table)
      .select(['id', ...snapFields].join(',')).eq('id', pk).maybeSingle();
    if (bErr) return { ok: false, status: 'db_error', data: null, error: `before 读取失败: ${bErr.message}`, affectedRows: 0, before: null };
    if (!b) return { ok: false, status: 'zero_rows', data: null, error: `目标行不存在或不可见(${table}#${pk})`, affectedRows: 0, before: null };
    before = b;
  }

  // ② 写 + 行数断言
  const res = await safeMutation<T>(args);
  if (!res.ok) return { ...res, before };

  // ③ 写后回读验证(verified outcome,不信写入返回)
  let after: Record<string, any> | null = null;
  if (pk) {
    const { data: a, error: aErr } = await client.from(table)
      .select(['id', ...snapFields].join(',')).eq('id', pk).maybeSingle();
    if (aErr || !a) {
      return { ...res, ok: false, status: 'verification_failed', error: `写后回读失败: ${aErr?.message || '行消失'}`, before, after: null };
    }
    after = a;
    const expect = ctx.verifyFields ?? payload ?? {};
    for (const [k, v] of Object.entries(expect)) {
      if (!(k in (after as any))) continue;   // 未回读的字段不断言
      const got = (after as any)[k];
      // 宽松相等:日期/数字的字符串形态差异不算失配
      const norm = (x: any) => (x === null || x === undefined) ? null : typeof x === 'number' ? String(x) : String(x);
      if (norm(got) !== norm(v)) {
        return { ...res, ok: false, status: 'verification_failed', before, after,
          error: `回读验证失败: ${table}.${k} 期望 ${JSON.stringify(v)} 实际 ${JSON.stringify(got)}` };
      }
    }
  }

  // ④ 审计留痕(现有能力;失败不阻断已验证主写,但必须留下失败痕迹)
  if (args.auditOrderId) {
    try {
      const { error: logErr } = await client.from('order_logs').insert({
        order_id: args.auditOrderId,
        action: `critical_mutation:${table}`,
        operator_id: ctx.actor === 'system' ? null : ctx.actor,
        detail: JSON.stringify({
          reason: ctx.reason, risk: ctx.riskLevel, decision_id: ctx.decisionId || null,
          before: pickFields(before, snapFields), after: pickFields(after, snapFields),
        }).slice(0, 2000),
      }).select('id');
      if (logErr) console.error(`[safeCriticalMutation] 审计写入失败(主写已验证,不回滚): ${logErr.message}`);
    } catch (e: any) {
      console.error(`[safeCriticalMutation] 审计异常: ${e?.message}`);
    }
  }

  return { ...res, before, after };
}

function pickFields(row: Record<string, any> | null, fields: string[]): Record<string, any> | null {
  if (!row) return null;
  const out: Record<string, any> = {};
  for (const f of fields) if (f in row) out[f] = row[f];
  return out;
}
