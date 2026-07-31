'use server';

/**
 * 建单表单字段规则的覆盖层读写(2026-07-31,L2 第二步)。
 *
 * 代码默认在 lib/domain/formRules.ts;本表只存**差异**。
 * 读:所有登录用户(建单表单要靠它决定渲染成什么样)。
 * 写:仅 admin(改这张表等于改所有人的建单表单)。
 *
 * ⚠️ 表缺失/查询出错时一律**降级为"无覆盖"**,而不是报错阻断 ——
 *    覆盖层挂了应该退回代码默认(=现在的线上行为),不能让建单页整个打不开。
 */

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';
import { ORDER_CREATE_RULES, type FieldRuleOverride } from '@/lib/domain/formRules';

const FORM_KEY = 'order_create';

export interface FormFieldRuleRow {
  id: string;
  field_name: string;
  scope: 'global' | 'customer';
  scope_id: string | null;
  visible: boolean | null;
  required: boolean | null;
  default_value: string | null;
  note: string | null;
}

async function auth() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, userId: undefined, isAdmin: false };
  const { data: p } = await (supabase.from('profiles') as any).select('role, roles').eq('user_id', user.id).single();
  const roles: string[] = (p as any)?.roles?.length ? (p as any).roles : [(p as any)?.role].filter(Boolean);
  return { supabase, userId: user.id, isAdmin: roles.includes('admin') };
}

/**
 * 取某客户建单时生效的覆盖(global 在前、customer 在后 —— resolveOrderFormRules 靠这个顺序定优先级)。
 * 不传 customerId 就只返回 global。
 */
export async function getOrderFormOverrides(customerId?: string | null): Promise<FieldRuleOverride[]> {
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return [];
    let q = (supabase.from('form_field_rules') as any)
      .select('field_name, scope, scope_id, visible, required, default_value')
      .eq('form_key', FORM_KEY);
    q = customerId
      ? q.or(`scope.eq.global,and(scope.eq.customer,scope_id.eq.${customerId})`)
      : q.eq('scope', 'global');
    const { data, error } = await q;
    if (error) return [];   // 表没建/查询出错 → 退回代码默认,不阻断建单
    const rows = (data || []) as any[];
    // global 必须排在 customer 前面:后来的压先来的
    return rows
      .sort((a, b) => (a.scope === 'global' ? 0 : 1) - (b.scope === 'global' ? 0 : 1))
      .map((r) => ({
        field_name: r.field_name,
        visible: r.visible,
        required: r.required,
        default_value: r.default_value,
      }));
  } catch {
    return [];
  }
}

/** 管理页用:列出全部覆盖(含 id/note,便于编辑删除)。 */
export async function listFormFieldRules(): Promise<{ data?: FormFieldRuleRow[]; error?: string }> {
  const { supabase, userId, isAdmin } = await auth();
  if (!userId) return { error: '请先登录' };
  if (!isAdmin) return { error: '仅管理员可查看表单字段配置' };
  const { data, error } = await (supabase.from('form_field_rules') as any)
    .select('id, field_name, scope, scope_id, visible, required, default_value, note')
    .eq('form_key', FORM_KEY)
    .order('scope', { ascending: true })
    .order('field_name', { ascending: true });
  if (error) {
    if (/form_field_rules|does not exist|schema cache/i.test(error.message || '')) {
      return { error: '字段配置表尚未建立:请先执行迁移 20260731_form_field_rules.sql' };
    }
    return { error: error.message };
  }
  return { data: (data || []) as FormFieldRuleRow[] };
}

/** 新增/更新一条覆盖。visible/required 传 null = 该项不覆盖(沿用代码默认)。 */
export async function upsertFormFieldRule(input: {
  id?: string | null;
  fieldName: string;
  scope: 'global' | 'customer';
  scopeId?: string | null;
  visible: boolean | null;
  required: boolean | null;
  defaultValue?: string | null;
  note?: string | null;
}): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, isAdmin } = await auth();
  if (!userId) return { error: '请先登录' };
  if (!isAdmin) return { error: '仅管理员可修改表单字段配置' };

  // 只允许配代码里真实存在的字段 —— 否则配了个拼错的字段名,页面上毫无反应,人还以为生效了
  if (!ORDER_CREATE_RULES[input.fieldName]) {
    return { error: `字段「${input.fieldName}」不在建单表单里。可配的字段见配置页下拉。` };
  }
  if (input.scope === 'customer' && !input.scopeId) return { error: '按客户配置时必须选择客户' };
  if (input.scope === 'global' && input.scopeId) return { error: '全局配置不能指定客户' };
  // 三项全空 = 什么也没覆盖,存下来只会让人以为配了
  if (input.visible === null && input.required === null && !input.defaultValue) {
    return { error: '至少要设置 显示/必填/默认值 其中一项,否则这条配置没有任何作用' };
  }

  const row = {
    form_key: FORM_KEY,
    field_name: input.fieldName,
    scope: input.scope,
    scope_id: input.scope === 'customer' ? input.scopeId : null,
    visible: input.visible,
    required: input.required,
    default_value: input.defaultValue || null,
    note: input.note || null,
    updated_at: new Date().toISOString(),
    updated_by: userId,
  };

  const { error } = input.id
    ? await (supabase.from('form_field_rules') as any).update(row).eq('id', input.id)
    : await (supabase.from('form_field_rules') as any).insert(row);

  if (error) {
    if (/duplicate key|form_field_rules_.*_uniq/i.test(error.message || '')) {
      return { error: '这个字段在该作用域下已经配过了 —— 请直接编辑那一条,不要新增。' };
    }
    if (/form_field_rules|does not exist|schema cache/i.test(error.message || '')) {
      return { error: '字段配置表尚未建立:请先执行迁移 20260731_form_field_rules.sql' };
    }
    return { error: error.message };
  }
  revalidatePath('/admin/form-rules');
  revalidatePath('/orders/new');
  return { ok: true };
}

/** 删除一条覆盖 → 该字段回到代码默认。 */
export async function deleteFormFieldRule(id: string): Promise<{ ok?: boolean; error?: string }> {
  const { supabase, userId, isAdmin } = await auth();
  if (!userId) return { error: '请先登录' };
  if (!isAdmin) return { error: '仅管理员可修改表单字段配置' };
  const { error } = await (supabase.from('form_field_rules') as any).delete().eq('id', id);
  if (error) return { error: error.message };
  revalidatePath('/admin/form-rules');
  revalidatePath('/orders/new');
  return { ok: true };
}

/** 配置页下拉用:可配的字段清单(名字 + 代码默认值,让人知道自己在改什么)。 */
export async function listConfigurableFields(): Promise<{
  data: Array<{ field: string; label: string; defaultVisible: boolean; defaultRequired: string }>;
}> {
  return {
    data: Object.entries(ORDER_CREATE_RULES).map(([field, r]) => ({
      field,
      label: r.label,
      defaultVisible: r.visible,
      // required 可能是函数(随情境变化),这里给人话而不是 true/false
      defaultRequired: typeof r.required === 'function' ? '视情况' : (r.required ? '必填' : '选填'),
    })),
  };
}
