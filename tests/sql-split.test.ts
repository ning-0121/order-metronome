import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { splitSql } from '../scripts/db/sql-split';

describe('splitSql', () => {
  it('按顶层分号切,普通多语句', () => {
    expect(splitSql('select 1; select 2;')).toEqual(['select 1', 'select 2']);
  });

  it('美元引用体($$)内的分号不切', () => {
    const sql = `create function f() returns void language plpgsql as $$ begin execute 'a'; execute 'b'; end; $$; grant x;`;
    const out = splitSql(sql);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("execute 'a'; execute 'b';");   // 函数体完整
    expect(out[1]).toBe('grant x');
  });

  it('具名美元 tag($tag$)也保护', () => {
    const sql = `do $mig$ begin perform 1; end $mig$;`;
    expect(splitSql(sql)).toEqual([`do $mig$ begin perform 1; end $mig$`]);
  });

  it('行注释 -- 里的分号不切', () => {
    expect(splitSql('select 1; -- a; b\nselect 2;')).toEqual(['select 1', '-- a; b\nselect 2']);
  });

  it('块注释 /* */ 里的分号不切', () => {
    expect(splitSql('select 1 /* x; y */; select 2;')).toEqual(['select 1 /* x; y */', 'select 2']);
  });

  it("字符串里的分号与 '' 转义不切", () => {
    expect(splitSql("insert values ('a;b', 'it''s'); select 2;"))
      .toEqual(["insert values ('a;b', 'it''s')", 'select 2']);
  });

  it('尾部无分号的语句也算一条', () => {
    expect(splitSql('select 1')).toEqual(['select 1']);
  });

  it('空/纯注释输入 → 空数组', () => {
    expect(splitSql('  \n -- 只有注释\n ')).toEqual([]);
  });

  // 回归护栏:切分器对全部真实迁移不切坏(美元体成对、含函数/DO 文件体完整)
  it('全部真实迁移文件切分后美元引用成对、无切坏', () => {
    const dir = resolve(import.meta.dirname, '../supabase/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(100);
    for (const f of files) {
      const stmts = splitSql(readFileSync(join(dir, f), 'utf-8'));
      for (const s of stmts) {
        const tags = s.match(/\$[A-Za-z_]*\$/g) || [];
        const counts: Record<string, number> = {};
        for (const t of tags) counts[t] = (counts[t] || 0) + 1;
        for (const c of Object.values(counts)) expect(c % 2, `${f}: 美元引用不成对`).toBe(0);
      }
    }
  });
});
