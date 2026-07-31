import { describe, it, expect } from 'vitest';

/**
 * 建单表单「必填进度」的统计口径(2026-07-31)。
 *
 * 与 components/order/FormSection.tsx 里的 countRequired 同一份判定,复制到此处做纯逻辑测试
 * (vitest 环境是 node,没有 DOM;仓库刚把依赖漏洞从 18 收到 4,不值得为一个测试引 jsdom)。
 * FormData 对折叠字段的真实行为另在浏览器里实测过 —— 见本文件末尾说明。
 *
 * 这条口径要守住的是:**折起来 ≠ 填好了**。若折叠区的必填被排除出统计,
 * 进度条会显示"必填已齐"但提交时被浏览器原生校验拦下,用户看不懂为什么点不动。
 */

type El = {
  tag: 'input' | 'select' | 'textarea';
  type?: string;
  required?: boolean;
  disabled?: boolean;
  value?: string;
  checked?: boolean;
  files?: unknown[];
};

/** 复刻 FormSection.countRequired 的判定 */
function countRequired(els: El[]) {
  const req = els.filter((e) => e.required && !e.disabled && e.type !== 'hidden');
  const done = req.filter((e) => {
    if (e.tag === 'input' && (e.type === 'checkbox' || e.type === 'radio')) return !!e.checked;
    if (e.tag === 'input' && e.type === 'file') return !!e.files?.length;
    return String(e.value || '').trim() !== '';
  }).length;
  return { done, total: req.length };
}

const inp = (o: Partial<El> = {}): El => ({ tag: 'input', type: 'text', required: true, ...o });

describe('必填进度统计口径', () => {
  it('填了算已填,空的不算', () => {
    expect(countRequired([inp({ value: '伊彤' }), inp({ value: '' })])).toEqual({ done: 1, total: 2 });
  });

  it('纯空格不算已填 —— 否则敲个空格就能骗过进度条', () => {
    expect(countRequired([inp({ value: '   ' })]).done).toBe(0);
  });

  it('非必填不进分母', () => {
    expect(countRequired([inp({ value: 'x' }), inp({ required: false, value: '' })]).total).toBe(1);
  });

  it('disabled 的必填不计 —— 它提交时本来也不会带上', () => {
    expect(countRequired([inp({ value: 'x' }), inp({ disabled: true, value: '' })])).toEqual({ done: 1, total: 1 });
  });

  it('type=hidden 的必填不计 —— 那不是给人填的(如 is_import)', () => {
    expect(countRequired([inp({ value: 'x' }), inp({ type: 'hidden', value: '' })]).total).toBe(1);
  });

  it('checkbox 看 checked 而不是 value', () => {
    expect(countRequired([inp({ type: 'checkbox', checked: true, value: '' })]).done).toBe(1);
    expect(countRequired([inp({ type: 'checkbox', checked: false, value: 'on' })]).done).toBe(0);
  });

  it('file 看有没有选中文件', () => {
    expect(countRequired([inp({ type: 'file', files: [{}] })]).done).toBe(1);
    expect(countRequired([inp({ type: 'file', files: [] })]).done).toBe(0);
  });

  it('select / textarea 与 input 同口径', () => {
    expect(countRequired([
      { tag: 'select', required: true, value: 'DDP' },
      { tag: 'textarea', required: true, value: '' },
    ])).toEqual({ done: 1, total: 2 });
  });

  it('折起来 ≠ 填好了 —— 折叠不改变任何入参,统计必须原样', () => {
    // SectionHeader 折叠只把节点设 hidden,不动 required/disabled/value,
    // 所以统计结果必须与展开时完全一致。
    const fields = [inp({ value: '' }), inp({ value: '2026-10-01' })];
    const 展开 = countRequired(fields);
    const 折叠 = countRequired(fields);   // 折叠不改数据
    expect(折叠).toEqual(展开);
    expect(折叠).toEqual({ done: 1, total: 2 });
  });
});

/**
 * ── FormData 与折叠的关系(浏览器实测,非本文件断言)──
 *
 * SectionHeader 折叠用的是 hidden 属性。HTML 规范里 form.elements 的排除条件只有
 * disabled 和无 name,不含 hidden / display:none —— 即折叠区字段照常提交。
 * 已在真实浏览器执行 new FormData(form) 验证:hidden 容器内的 input/select/textarea 全部带上。
 *
 * ⚠️ 因此折叠实现有两条红线,谁改都不能碰:
 *   1. 不能改成条件渲染({open && <div>…</div>})—— 节点卸载后字段直接消失;
 *   2. 不能给折叠区加 disabled —— 那才是真的会掉出 FormData。
 * 两者都会让"折叠状态下提交"**静默丢字段**,建单丢个 factory_date 就是一张排不出期的单,且无报错。
 */
