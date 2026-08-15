/**
 * Procurement Generator P0 —— 隔离 Pilot Smoke(Adapter 层,不连生产库)
 *
 * 纯函数测试(test-procurement-p0-advance.ts)覆盖的是**判定**;
 * 本 smoke 覆盖的是**映射与门禁** —— Adapter 把表字段翻成契约形状对不对、
 * Pilot env 双闸认不认、列漂移降级会不会把错误泄漏到上层。
 *
 * 用注入的 stub client 跑,**不碰任何真实数据**(P0 明确不做生产数据变更)。
 * 运行:node --import tsx scripts/smoke-procurement-p0-pilot.ts
 */
import { createProcurementAdapter } from '../lib/adapters/supabase/procurementAdapter';
import { RepositoryError } from '../lib/repositories/contracts/procurement';
import { isPilotOrder, pilotOrderNos } from '../lib/procurement/pilot';

let failed = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { console.log(`  ✅ ${name}`); return; }
  failed++;
  console.error(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
}

type StubResult = { data?: any; error?: any; count?: number };

/**
 * 最小 supabase 查询构造器 stub:可链式 .eq()/.maybeSingle(),也可直接 await。
 * 值传数组时表示**按调用次序**依次返回(用来真实模拟「第一次缺列报错 → 降级重读成功」)。
 */
function makeClient(tables: Record<string, StubResult | StubResult[]>) {
  const seen: string[] = [];
  const calls = new Map<string, number>();
  return {
    _seen: seen,
    from(table: string) {
      seen.push(table);
      const spec = tables[table] ?? { data: null, error: null };
      let result: StubResult;
      if (Array.isArray(spec)) {
        const n = calls.get(table) ?? 0;
        calls.set(table, n + 1);
        result = spec[Math.min(n, spec.length - 1)] ?? { data: null, error: null };
      } else {
        result = spec;
      }
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: result.data ?? null, error: result.error ?? null }),
        single: async () => ({ data: result.data ?? null, error: result.error ?? null }),
        then: (resolve: any) =>
          resolve({ data: result.data ?? null, error: result.error ?? null, count: result.count ?? 0 }),
      };
      return builder;
    },
  } as any;
}

async function main() {
  console.log('\n【A】Pilot 双闸(白名单 + 上限)');
  {
    const env = { PROCUREMENT_GENERATOR_PILOT: 'EHL-2601,EHL-2602' } as any;
    check('白名单命中', isPilotOrder({ order_no: 'EHL-2601' }, env) === true);
    check('大小写不敏感', isPilotOrder({ order_no: 'ehl-2602' }, env) === true);
    check('名单外不放行', isPilotOrder({ order_no: 'EHL-9999' }, env) === false);
    check('internal_order_no 也认', isPilotOrder({ internal_order_no: 'EHL-2601' }, env) === true);
    check('默认 off', isPilotOrder({ order_no: 'EHL-2601' }, {} as any) === false);
    check('显式 off', isPilotOrder({ order_no: 'EHL-2601' }, { PROCUREMENT_GENERATOR_PILOT: 'off' } as any) === false);

    const many = Array.from({ length: 20 }, (_, i) => `O-${i}`).join(',');
    const capped = pilotOrderNos({ PROCUREMENT_GENERATOR_PILOT: many } as any);
    check('超上限取前 N 而不是全放行(默认 5)', capped.length === 5, String(capped.length));
  }

  console.log('\n【B】getOrderIdentity 映射');
  {
    const repo = createProcurementAdapter(
      makeClient({ orders: { data: { id: 'o1', order_no: 'EHL-2601', internal_order_no: ' QM-77 ' } } }),
    );
    const id = await repo.getOrderIdentity('o1');
    check('orderNo 取到', id?.orderNo === 'EHL-2601', String(id?.orderNo));
    check('internalOrderNo 去空白', id?.internalOrderNo === 'QM-77', String(id?.internalOrderNo));

    const none = createProcurementAdapter(makeClient({ orders: { data: null } }));
    check('订单不存在 → null(不抛)', (await none.getOrderIdentity('nope')) === null);
  }

  console.log('\n【C】列漂移降级只发生在 Adapter 内');
  {
    // 真实模拟:第一次查带 internal_order_no 报「列不存在」→ Adapter 降级去掉该列重读。
    const repo = createProcurementAdapter(
      makeClient({
        orders: [
          { data: null, error: { message: 'column orders.internal_order_no does not exist', code: '42703' } },
          { data: { id: 'o1', order_no: 'EHL-2601' } },
        ],
      }),
    );
    const id = await repo.getOrderIdentity('o1');
    check('降级后仍拿到 orderNo(没把缺列变成故障)', id?.orderNo === 'EHL-2601', String(id?.orderNo));
    check('缺列时 internalOrderNo = null 而非崩', id?.internalOrderNo === null);

    // 非缺列的错误不许被降级路径吞掉
    const realFail = createProcurementAdapter(
      makeClient({
        orders: [
          { data: null, error: { message: 'connection reset', code: '08006' } },
          { data: { id: 'o1', order_no: 'X' } },
        ],
      }),
    );
    let thrown: unknown = null;
    try { await realFail.getOrderIdentity('o1'); } catch (e) { thrown = e; }
    check('真故障不走降级、照常抛错', thrown instanceof RepositoryError, String(thrown));
  }

  console.log('\n【D】getOrderProcurementSource 映射 + basis 搬运(不判定)');
  {
    const repo = createProcurementAdapter(
      makeClient({
        orders: { data: { id: 'o1', order_no: 'EHL-2601', quantity: 1200, factory_date: '2026-09-01', etd: null } },
        materials_bom: {
          data: [
            { id: 'b1', material_name: '75D 四面弹', qty_per_piece: 0.42, unit: 'KG', consumption_basis: 'PER_PIECE', color: '黑' },
            { id: 'b2', material_name: '主标', qty_per_piece: 1, unit: '个', consumption_basis: null, color: null },
          ],
        },
        material_requirements: { count: 7 },
      }),
    );
    const src = await repo.getOrderProcurementSource('o1');
    check('订单数量映射', src.order.quantity === 1200);
    check('etd 空 → null', src.order.etd === null);
    check('BOM 两行', src.bom.length === 2);
    check('basis 原样搬运(已确认)', src.bom[0].consumptionBasis === 'PER_PIECE');
    check('basis 原样搬运(未确认→null,不替它猜)', src.bom[1].consumptionBasis === null);
    check('requirementCount 用 count 不是 data.length', src.requirementCount === 7, String(src.requirementCount));
  }

  console.log('\n【E】DB error → RepositoryError,PostgrestError 不泄漏');
  {
    const repo = createProcurementAdapter(
      makeClient({ orders: { data: null, error: { message: 'relation "orders" does not exist', code: '42P01' } } }),
    );
    let caught: unknown = null;
    try { await repo.getOrderIdentity('o1'); } catch (e) { caught = e; }
    check('抛的是 RepositoryError', caught instanceof RepositoryError, String(caught));
    check('code 归类为 io', (caught as RepositoryError)?.code === 'io');
    check('原始 error 保留在 cause(可排查)', (caught as RepositoryError)?.cause != null);

    const denied = createProcurementAdapter(
      makeClient({ orders: { data: null, error: { message: 'permission denied', code: '42501' } } }),
    );
    let permErr: unknown = null;
    try { await denied.getOrderIdentity('o1'); } catch (e) { permErr = e; }
    check('42501 → permission', (permErr as RepositoryError)?.code === 'permission');
  }

  console.log('\n【F】getProcurementDraft:待采购 N 项 + 执行行双状态列');
  {
    const repo = createProcurementAdapter(
      makeClient({
        procurement_items: {
          data: [
            { id: 'i1', consolidation_key: 'k1', material_name: '75D', status: 'draft', needs_reconfirm: false, final_purchase_qty: null, suggested_purchase_qty: 520 },
            { id: 'i2', consolidation_key: 'k2', material_name: '主标', status: 'confirmed', needs_reconfirm: true, final_purchase_qty: 1200, suggested_purchase_qty: 1200 },
          ],
        },
        procurement_line_items: {
          data: [
            { id: 'l1', procurement_item_id: 'i2', size: null, ordered_qty: 1200, line_status: 'pending_order', status: null, purchase_order_id: null },
            { id: 'l2', procurement_item_id: null, size: 'M', ordered_qty: 30, line_status: null, status: 'complete', purchase_order_id: 'po1' },
          ],
        },
      }),
    );
    const draft = await repo.getProcurementDraft('o1');
    check('待采购项数 = 2(「待采购 N 项」的 N)', draft.items.length === 2);
    check('needs_reconfirm 转 boolean', draft.items[1].needsReconfirm === true);
    check('canonical 状态进 lineStatus', draft.executionLines[0].lineStatus === 'pending_order');
    check('legacy 状态单独暴露,不混进 lineStatus', draft.executionLines[1].lineStatus === null && draft.executionLines[1].legacyStatus === 'complete');
    check('孤儿行 procurementItemId = null(不变量检查靠它)', draft.executionLines[1].procurementItemId === null);
  }

  console.log(
    failed === 0
      ? '\n✅ P0 隔离 Pilot smoke 全部通过(Adapter 映射 / Pilot 门禁 / 错误转换)\n'
      : `\n❌ ${failed} 项未通过\n`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main();
