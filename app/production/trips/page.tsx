import Link from 'next/link';
import { getTripsBoard } from '@/app/actions/factory-trips';
import { TripsBoardClient } from '@/components/production/TripsBoardClient';

export const dynamic = 'force-dynamic';

/**
 * 出车行程 / 行车路径(2026-07-27 CEO):按日程规划去哪些工厂,共享到系统,别人可挂捎带。
 * 导航靠工厂地址生成高德/百度深链(需先在「工厂管理」补地址)。
 */
export default async function TripsPage() {
  const board = await getTripsBoard();
  if (board.error) return <div className="mx-auto max-w-3xl px-4 py-12 text-center text-gray-500">{board.error}</div>;

  const noAddr = board.allFactories.filter((f) => !f.address).length;

  return (
    <main className="mx-auto max-w-3xl px-3 py-4 sm:px-4">
      <div className="mb-1 flex items-center justify-between gap-2 flex-wrap">
        <h1 className="text-xl font-bold text-gray-900">🚗 出车行程 · 捎带</h1>
        <Link href="/production" className="text-sm text-indigo-600 hover:underline">← 生产中心</Link>
      </div>
      <p className="text-sm text-gray-500 mb-3">按日程规划去哪些工厂,发到这里团队共享;别人可挂"帮我带东西到某厂"。点工厂地址一键导航。</p>
      {noAddr > 0 && (
        <div className="mb-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
          ⚠ 有 <b>{noAddr}</b> 家工厂还没填地址 → 导航用不了。去 <Link href="/factories" className="underline">工厂管理</Link> 补「地址」字段。
        </div>
      )}
      <TripsBoardClient board={board} />
    </main>
  );
}
