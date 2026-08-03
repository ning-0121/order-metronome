/**
 * 建单字段白名单一致性(2026-08-03 P0 回归后立)。
 *
 * 事故:createOrder 明写 `lifecycle_status: 'active'`,但 ordersRepo 的 INSERT_WHITELIST
 * 里没有这个字段 → sanitizePayload **静默丢弃** → 落 DB 默认值 'draft'
 * → **新单一出生就是草稿**。草稿单不进 AI 巡检/晨报/日报三大风险面板,
 * 「卡风险」这个产品命门直接失效,而且全程不报错、不留日志。
 *
 * 这已经是同一个症状第二次出现:
 *   2026-07-06  新单没显式设状态 → 落默认 '草稿'(orders.ts:447 注释记着)
 *   2026-08-03  设了,但被白名单吃掉
 *
 * 白名单漏字段是**静默失败**——代码看着写了、数据库里没有,只能靠这种一致性检查发现。
 * 这里扫源码文本比对:createOrder 的 insertPayload 里出现的字段,必须全在 INSERT_WHITELIST 里。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf-8');

function whitelist(name: string): Set<string> {
  const src = read('lib/repositories/ordersRepo.ts');
  const i = src.indexOf(`const ${name} = [`);
  const j = src.indexOf('] as const;', i);
  expect(i, `找不到 ${name}`).toBeGreaterThan(-1);
  return new Set([...src.slice(i, j).matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]));
}

function insertPayloadKeys(): Set<string> {
  const src = read('app/actions/orders.ts');
  const i = src.indexOf('const insertPayload: Record<string, any> = {');
  expect(i, '找不到 createOrder 的 insertPayload').toBeGreaterThan(-1);
  const j = src.indexOf('\n  };', i);
  const body = src.slice(i, j);
  const keys = new Set<string>();
  for (const m of body.matchAll(/^\s{4}([a-z0-9_]+)\s*:/gm)) keys.add(m[1]);   // key: value
  for (const m of body.matchAll(/^\s{4}([a-z0-9_]+),\s*$/gm)) keys.add(m[1]);  // 简写属性
  return keys;
}

describe('createOrder 写的字段不许被白名单静默吃掉', () => {
  it('insertPayload 的每个字段都在 INSERT_WHITELIST 里', () => {
    const ins = whitelist('INSERT_WHITELIST');
    const dropped = [...insertPayloadKeys()].filter((k) => !ins.has(k)).sort();
    expect(
      dropped,
      '这些字段 createOrder 设了、但会被 sanitizePayload 丢弃(不报错,直接落 DB 默认值)',
    ).toEqual([]);
  });

  it('lifecycle_status 必须在白名单里 —— 少了它新单会变草稿', () => {
    // 单独立一条:这个字段掉了的后果最重(新单不进风险面板),值得一眼看见
    expect(whitelist('INSERT_WHITELIST').has('lifecycle_status')).toBe(true);
  });

  it('createOrder 仍然显式把新单设为 active(别再依赖 DB 默认值)', () => {
    expect(read('app/actions/orders.ts')).toContain("lifecycle_status: 'active'");
  });
});
