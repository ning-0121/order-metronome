import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';
import { getCurrentUserRole } from '@/lib/utils/user-role';
import Link from 'next/link';
import { TrainingClient } from './TrainingClient';

export default async function TrainingPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { isAdmin } = await getCurrentUserRole(supabase);
  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12 text-center">
        <p className="text-gray-500 mb-4">训练数据管理仅限管理员访问</p>
        <Link href="/quoter" className="text-indigo-600 hover:underline">返回报价员主页</Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <Link href="/quoter" className="text-xs text-gray-400 hover:text-gray-600">
            ← 返回报价员
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-pink-600 text-white text-2xl">
            📚
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">训练数据</h1>
            <p className="text-sm text-gray-500">
              上传工价单 → Claude Vision 自动识别 → 人工复核 → 写入知识库
            </p>
          </div>
        </div>
      </div>

      <TrainingClient />
    </div>
  );
}
