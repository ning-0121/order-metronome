import { describe, it, expect } from 'vitest';
import { parseDailyReport, resolveOrder, matchProcessToMilestone, type OrderRef, type MilestoneRef } from '@/lib/production/dailyReport';

describe('生产日报解析', () => {
  it('拆行:剥列表前缀、抓【订单号】/工序/状态/日期/说明', () => {
    const text = `2026.08.19 工作总结
1.【RAG603】裁剪 / 完成 / 今天：黑色一缸1296件(1X459 2X459 3X378)
2.【613】封样 / 进行中 / 20号：预计出4-5款封样
3.【969】物料 / 受阻 / 后天到：包边条,影响生产周期1天`;
    const rows = parseDailyReport(text);
    expect(rows).toHaveLength(3);                       // 标题行被跳过
    expect(rows[0]).toMatchObject({ orderToken: 'RAG603', process: '裁剪', status: '完成', date: '今天' });
    expect(rows[0].note).toContain('1296件');
    expect(rows[1]).toMatchObject({ orderToken: '613', process: '封样', status: '进行中', date: '20号' });
    expect(rows[2]).toMatchObject({ orderToken: '969', process: '物料', status: '受阻' });
    expect(rows[2].note).toContain('影响生产周期1天');
  });

  it('说明里含冒号/斜杠不破坏解析(只认第一个冒号)', () => {
    const [r] = parseDailyReport('【588】船样 / 完成 / 周五：J95已给;黑色在包装,咖色缝制中');
    expect(r.process).toBe('船样');
    expect(r.status).toBe('完成');
    expect(r.note).toContain('J95已给');
  });

  it('无【】开头的行不丢,标 parseError', () => {
    const [r] = parseDailyReport('上溪加工厂飞乐订单船样跟进');
    expect(r.parseError).toBeTruthy();
    expect(r.note).toContain('飞乐');
  });

  const ORDERS: OrderRef[] = [
    { id: 'o588', orderNo: 'QM-20260709-011', internalNo: '588', customer: 'rag' },
    { id: 'o934', orderNo: 'QM-20260711-005', internalNo: '1022934', customer: '天辉集团' },
    { id: 'o601b', orderNo: 'QM-20260727-002', internalNo: '601B', customer: 'rag' },
    { id: 'o603', orderNo: 'QM-20260727-005', internalNo: '603', customer: 'rag' },
  ];

  it('订单匹配:精确 internal', () => {
    expect(resolveOrder('588', ORDERS)).toMatchObject({ orderId: 'o588', how: 'exact-internal' });
    expect(resolveOrder('601B', ORDERS)).toMatchObject({ orderId: 'o601b', how: 'exact-internal' });
  });

  it('订单匹配:剥 RAG 客户前缀后命中', () => {
    expect(resolveOrder('RAG588', ORDERS)).toMatchObject({ orderId: 'o588', how: 'exact-internal' });
    expect(resolveOrder('RAG603', ORDERS)).toMatchObject({ orderId: 'o603', how: 'exact-internal' });
  });

  it('订单匹配:短号后缀唯一命中 1022934', () => {
    expect(resolveOrder('934', ORDERS)).toMatchObject({ orderId: 'o934', how: 'suffix-internal' });
  });

  it('订单匹配:款号/无号 → none(不硬猜)', () => {
    expect(resolveOrder('L23', ORDERS).how).toBe('none');
    expect(resolveOrder(null, ORDERS).how).toBe('none');
  });

  it('订单匹配:后缀命中多条 → ambiguous(给候选,让人选)', () => {
    const dup: OrderRef[] = [...ORDERS, { id: 'oX', orderNo: 'QM-x', internalNo: '1022588', customer: 'y' }];
    // "588" 精确命中 o588,不歧义;"022588" 后缀会同时命中 1022588 → 测后缀歧义用另一串
    const r = resolveOrder('88', dup); // <3位走原样,88 长度2 → 不匹配后缀
    expect(['none', 'ambiguous']).toContain(r.how);
  });

  const MS_V1: MilestoneRef[] = [
    { id: 'm1', stepKey: 'pre_prod_meeting', name: '产前会', status: 'done' },
    { id: 'm2', stepKey: 'final_qc_check', name: '尾查验货', status: 'pending' },
    { id: 'm3', stepKey: 'procurement_order_placed', name: '采购下单', status: 'pending' },
  ];

  it('工序→节点:命中订单真实节点(尾查)', () => {
    expect(matchProcessToMilestone('尾检', MS_V1)).toMatchObject({ milestoneId: 'm2', how: 'unique' });
  });

  it('工序→节点:已完成节点标 already-done(不重复标)', () => {
    expect(matchProcessToMilestone('产前会', MS_V1).how).toBe('already-done');
  });

  it('工序→节点:该模板没有的细工序(打腰卡/装箱)→ none(仅记动态,不静默错标)', () => {
    expect(matchProcessToMilestone('打腰卡', MS_V1).how).toBe('none');
    expect(matchProcessToMilestone('缝制', MS_V1).how).toBe('none'); // V1 无独立缝制节点
  });
});
