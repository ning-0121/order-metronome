import { NextResponse } from 'next/server';
import { resetPasswordWithToken } from '@/app/actions/reset-password';

export async function POST(request: Request) {
  try {
    const { token, password } = await request.json();

    if (!token) {
      return NextResponse.json({ error: '缺少重置令牌' }, { status: 400 });
    }
    if (!password || password.length < 8) {
      return NextResponse.json({ error: '密码至少需要 8 位' }, { status: 400 });
    }

    const result = await resetPasswordWithToken(token, password);

    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err: any) {
    console.error('[api/reset-password] error:', err);
    return NextResponse.json({ error: err.message || '操作失败' }, { status: 500 });
  }
}
