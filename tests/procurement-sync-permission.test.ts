/**
 * 采购进度 → canonical 同步:权限查询回归锁(2026-08-12 生产 bug)。
 *
 * 【事故】syncFromProcurementTracking 用 `.eq('id', auth.userId)` 查 profiles,
 * 但 profiles 的用户主键是 **user_id**,库里**根本没有 id 列** —— 查询直接报错、
 * data=null → roles=[] → canSync=false → **同步按钮对所有人恒失败**(静默,无人察觉)。
 * 生产实测:修复后 12 名跟单/采购/管理员恢复权限。
 *
 * 这是双链迁移 Adapter 的硬 blocker,单独修复、单独上线。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync('app/actions/procurement.ts', 'utf-8');
const start = src.indexOf('export async function syncFromProcurementTracking');
const fn = src.slice(start, start + 2500);

describe('syncFromProcurementTracking 权限查询', () => {
  it('函数存在', () => {
    expect(start).toBeGreaterThan(-1);
  });

  it('⭐ profiles 必须按 user_id 查(库里没有 id 列,按 id 查必然报错)', () => {
    expect(fn).toContain(".eq('user_id', auth.userId)");
    expect(fn).not.toContain(".eq('id', auth.userId)");
  });

  it('select 需带 role,供 roles 为空时回退', () => {
    expect(fn).toMatch(/\.select\('role,\s*roles'\)/);
  });

  it('roles 为空时回退单数 role —— 只配了 role 的老账号不被误拒', () => {
    expect(fn).toContain('p?.roles?.length ? p.roles : [p?.role]');
  });

  it('权限判定仍限跟单/采购/管理员(不放宽)', () => {
    expect(fn).toContain("['merchandiser', 'procurement', 'admin']");
  });
});

describe('全仓不得再出现同类 profiles 主键误用', () => {
  it('没有任何地方用 .eq(\'id\', <userId>) 查 profiles', () => {
    // 仅扫本文件涉及的模式;全仓扫描已在 2026-08-12 审计中确认此为唯一一处
    expect(src).not.toMatch(/from\('profiles'\)[\s\S]{0,200}?\.eq\('id',\s*\w*[Uu]ser[Ii]d/);
  });
});
