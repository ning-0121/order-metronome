import { NextResponse } from 'next/server';
import { generateProductionOrderSheet } from '@/app/actions/manufacturing-order';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await generateProductionOrderSheet(id) as any;
  if (result?.error) return NextResponse.json({ error: result.error }, { status: 400 });
  const encoded = String(result?.base64 || '');
  if (!encoded) return NextResponse.json({ error: '生产任务单文件为空' }, { status: 500 });
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length === 0 || bytes.subarray(0, 2).toString('ascii') !== 'PK') {
    return NextResponse.json({ error: '生成的生产任务单不是有效 XLSX 文件' }, { status: 500 });
  }
  const filename = String(result.fileName || `生产任务单_${id}.xlsx`).replace(/[\r\n]/g, '_');
  return new NextResponse(bytes as any, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': String(bytes.length),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    },
  });
}
