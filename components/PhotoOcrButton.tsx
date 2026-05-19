'use client';

/**
 * 拍照自动填表按钮
 *
 * 业务背景：外勤生产/质检员手机拍纸质单据 → AI 识别 → 一键填入 checklist。
 *
 * 行为：
 *   1. 点击「📷 拍照自动填表」→ 调用相机（capture="environment" 直接调起后置）
 *      或从相册选图
 *   2. 上传前在客户端压缩到 max 1920px / 80% 质量，避免移动网络上传慢
 *   3. 调用 parseProductionPhoto server action
 *   4. 解析成功 → 把字段抛给父组件，由 ChecklistRenderer 填入表单
 *   5. 解析失败 → 友好提示，不阻塞用户手动填
 *
 * 仅在 PHOTO_OCR_SUPPORTED_STEPS 里的节点显示。
 */

import { useState, useRef } from 'react';
import { parseProductionPhoto } from '@/app/actions/photo-parser';

export const PHOTO_OCR_SUPPORTED_STEPS = new Set([
  'mid_qc_check',
  'final_qc_check',
  'finished_goods_warehouse',
]);

interface Props {
  stepKey: string;
  orderId: string;
  /** 解析成功后，把字段交给父组件填入表单 */
  onParsed: (fields: Record<string, any>, summary: string) => void;
}

/**
 * 压缩图片：max 1920px 长边 + JPEG 80%。
 * 手机原图常 4000px / 5MB+，直传到 Claude 慢且接近 8MB 上限。
 */
async function compressImage(file: File): Promise<{ base64: string; mediaType: string }> {
  const maxDim = 1920;
  const quality = 0.8;
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = URL.createObjectURL(file);
  });
  let w = img.width;
  let h = img.height;
  if (w > maxDim || h > maxDim) {
    if (w > h) {
      h = Math.round(h * maxDim / w);
      w = maxDim;
    } else {
      w = Math.round(w * maxDim / h);
      h = maxDim;
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 不可用');
  ctx.drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(img.src);

  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  // dataUrl: "data:image/jpeg;base64,xxxxx"
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) throw new Error('图片编码失败');
  return { base64: m[2], mediaType: m[1] };
}

export function PhotoOcrButton({ stepKey, orderId, onParsed }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{ summary: string; notes: string[]; fieldCount: number } | null>(null);
  // 预览：选完图先让用户确认「拍清楚了」再上传，避免糊图浪费一次 AI 调用
  const [pendingPreview, setPendingPreview] = useState<{
    previewUrl: string;
    base64: string;
    mediaType: string;
  } | null>(null);

  if (!PHOTO_OCR_SUPPORTED_STEPS.has(stepKey)) return null;

  // Step 1：选完图 → 压缩 + 显示预览，等用户确认
  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setError(null);
    setParsed(null);
    try {
      const { base64, mediaType } = await compressImage(f);
      const previewUrl = `data:${mediaType};base64,${base64}`;
      setPendingPreview({ previewUrl, base64, mediaType });
    } catch (err: any) {
      setError(err?.message || '图片处理失败');
    } finally {
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  // Step 2：用户确认「拍清楚了」 → 真正调 AI
  async function confirmAndParse() {
    if (!pendingPreview) return;
    setLoading(true);
    setError(null);
    try {
      const res = await parseProductionPhoto(pendingPreview.base64, pendingPreview.mediaType, stepKey, orderId);
      if (!res.ok || !res.fields) {
        setError(res.error || '识别失败，请重试');
        return;
      }
      const cleaned: Record<string, any> = {};
      for (const [k, v] of Object.entries(res.fields)) {
        if (v !== null && v !== undefined && v !== '') cleaned[k] = v;
      }
      onParsed(cleaned, res.summary || '');
      setParsed({
        summary: res.summary || '',
        notes: res.notes || [],
        fieldCount: Object.keys(cleaned).length,
      });
      setPendingPreview(null);
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }

  function retake() {
    setPendingPreview(null);
    setError(null);
    inputRef.current?.click();
  }

  return (
    <div className="rounded-lg border-2 border-dashed border-indigo-300 bg-indigo-50 p-3 sm:p-4">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-indigo-900">📷 拍照自动填表</p>
          <p className="text-xs text-indigo-700 mt-0.5">
            外勤拍纸质单 / 手写单 → AI 识别后自动填入下方表格，你只需核对修改
          </p>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFile}
        className="hidden"
        disabled={loading}
      />

      {/* 预览：让用户确认拍清楚了再调 AI */}
      {pendingPreview && (
        <div className="mt-3 rounded-md border border-indigo-200 bg-white p-2">
          <p className="text-xs text-indigo-800 font-medium mb-2">
            预览：看得清字才识别得准。模糊/反光/裁切不全请重拍。
          </p>
          <img
            src={pendingPreview.previewUrl}
            alt="预览"
            className="w-full max-h-64 object-contain rounded border border-gray-100 bg-gray-50"
          />
          <div className="mt-2 flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={confirmAndParse}
              disabled={loading}
              className="flex-1 px-4 py-3 sm:py-2 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 active:bg-indigo-800"
            >
              {loading ? '识别中…' : '✓ 看清楚了，上传识别'}
            </button>
            <button
              type="button"
              onClick={retake}
              disabled={loading}
              className="flex-1 px-4 py-3 sm:py-2 rounded-lg border border-indigo-300 bg-white text-indigo-700 text-sm font-medium hover:bg-indigo-100 disabled:opacity-50"
            >
              ↻ 重拍
            </button>
          </div>
        </div>
      )}

      {!pendingPreview && (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={loading}
          className="mt-3 w-full sm:w-auto px-5 py-3 rounded-lg bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 active:bg-indigo-800"
        >
          📷 拍照 / 选图
        </button>
      )}

      {parsed && (
        <div className="mt-3 rounded-md bg-white border border-indigo-200 p-2.5 text-xs text-indigo-900">
          <p className="font-medium">✓ 已识别 {parsed.fieldCount} 个字段{parsed.summary ? ` — ${parsed.summary}` : ''}</p>
          {parsed.notes.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-amber-700">
              {parsed.notes.map((n, i) => <li key={i}>⚠ {n}</li>)}
            </ul>
          )}
          <p className="mt-1 text-gray-500">字段已填入下方表格，请逐项核对后提交</p>
        </div>
      )}

      {error && (
        <p className="mt-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
          ⚠ {error}
        </p>
      )}
    </div>
  );
}
