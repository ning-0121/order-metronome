/**
 * SQL 语句切分器(从 db-migrate.mts 抽出,便于单测 · 2026-07-24 根因6)。
 * 把一个 .sql 文件切成独立语句(exec_sql 底层 plpgsql EXECUTE 一次只能跑一条)。
 * 尊重:单引号字符串('' 转义)、-- 行注释、块注释、$$/$tag$ 美元引用体(体内 ; 不切)。
 */
// 去掉注释后是否只剩空白(纯注释/空白段不该喂给 exec_sql,否则 "cannot execute empty query")。
const isBlankStmt = (s: string) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim() === '';

export function splitSql(sql: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => { const t = raw.trim(); if (t && !isBlankStmt(t)) out.push(t); };
  let cur = '', i = 0;
  const n = sql.length;
  let inStr = false, dollar: string | null = null, lineC = false, blockC = false;
  while (i < n) {
    const c = sql[i], c2 = sql[i + 1];
    if (lineC) { cur += c; if (c === '\n') lineC = false; i++; continue; }
    if (blockC) { cur += c; if (c === '*' && c2 === '/') { cur += c2; i += 2; blockC = false; continue; } i++; continue; }
    if (dollar) { if (c === '$' && sql.startsWith(dollar, i)) { cur += dollar; i += dollar.length; dollar = null; continue; } cur += c; i++; continue; }
    if (inStr) { cur += c; if (c === "'") { if (c2 === "'") { cur += c2; i += 2; continue; } inStr = false; } i++; continue; }
    if (c === '-' && c2 === '-') { lineC = true; cur += c; i++; continue; }
    if (c === '/' && c2 === '*') { blockC = true; cur += c; i++; continue; }
    if (c === "'") { inStr = true; cur += c; i++; continue; }
    if (c === '$') { const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i)); if (m) { dollar = m[0]; cur += m[0]; i += m[0].length; continue; } }
    if (c === ';') { push(cur); cur = ''; i++; continue; }
    cur += c; i++;
  }
  push(cur);
  return out;
}
