'use client';

import { useState, useEffect, useRef } from 'react';
import {
  uploadTrainingFile,
  listTrainingSamples,
  reviewSample,
  deleteSample,
  reExtractSample,
} from '@/app/actions/quoter-training';

type Status = 'all' | 'pending_review' | 'confirmed' | 'rejected' | 'needs_edit';

const GARMENT_LABELS: Record<string, string> = {
  knit_top: '针织上衣',
  knit_bottom: '针织下装',
  woven_pants: '梭织长裤',
  woven_shorts: '梭织短裤',
};

const STATUS_STYLES: Record<string, string> = {
  pending_review: 'bg-amber-50 text-amber-700 border-amber-200',
  confirmed: 'bg-green-50 text-green-700 border-green-200',
  rejected: 'bg-gray-50 text-gray-500 border-gray-200',
  needs_edit: 'bg-blue-50 text-blue-700 border-blue-200',
};

const STATUS_LABELS: Record<string, string> = {
  pending_review: '待审核',
  confirmed: '已确认',
  rejected: '已拒绝',
  needs_edit: '需编辑',
};

export function TrainingClient() {
  const [samples, setSamples] = useState<any[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [status, setStatus] = useState<Status>('pending_review');
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  const [selectedSample, setSelectedSample] = useState<any | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    setLoading(true);
    const res = await listTrainingSamples(status);
    if (res.data) setSamples(res.data);
    if (res.counts) setCounts(res.counts);
    setLoading(false);
  }

  useEffect(() => {
    load();
  }, [status]);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    setUploading(true);
    setUploadProgress({ done: 0, total: files.length });

    let successCount = 0;
    const errors: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      try {
        const res = await uploadTrainingFile(f);
        if (res.error) {
          errors.push(`${f.name}: ${res.error}`);
        } else {
          successCount++;
        }
      } catch (e: any) {
        errors.push(`${f.name}: ${e?.message || '未知错误'}`);
      }
      setUploadProgress({ done: i + 1, total: files.length });
    }

    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';

    if (errors.length > 0) {
      alert(
        `${successCount}/${files.length} 上传成功\n\n失败：\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? `\n...还有 ${errors.length - 5} 条` : ''}`,
      );
    } else {
      alert(`✅ ${successCount} 份文件全部上传并识别完成`);
    }
    load();
  }

  async function handleConfirm(id: string) {
    const res = await reviewSample(id, 'confirm');
    if (res.error) alert(res.error);
    else {
      setSelectedSample(null);
      load();
    }
  }

  async function handleReject(id: string) {
    if (!confirm('拒绝这份样本？（不会删除文件，只是排除在训练数据之外）')) return;
    const res = await reviewSample(id, 'reject');
    if (res.error) alert(res.error);
    else {
      setSelectedSample(null);
      load();
    }
  }

  async function handleDelete(id: string) {
    if (!confirm('彻底删除这份样本？文件和数据都会清除，不可恢复。')) return;
    const res = await deleteSample(id);
    if (res.error) alert(res.error);
    else {
      setSelectedSample(null);
      load();
    }
  }

  async function handleReExtract(id: string) {
    if (!confirm('重新让 AI 识别一次？')) return;
    const res = await reExtractSample(id);
    if (res.error) alert(res.error);
    else {
      alert('✅ 重新识别完成');
      load();
    }
  }

  return (
    <div className="space-y-5">
      {/* 上传区 */}
      <div className="rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50/30 p-6">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.xlsx,.xls,.csv,.pdf"
          onChange={handleFileSelect}
          className="hidden"
          id="training-upload"
          disabled={uploading}
        />
        <label
          htmlFor="training-upload"
          className={`block text-center cursor-pointer ${uploading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          <div className="text-4xl mb-2">📥</div>
          <div className="text-sm font-semibold text-gray-800 mb-1">
            {uploading
              ? `上传中 ${uploadProgress.done} / ${uploadProgress.total} ...`
              : '拖拽或点击上传工价单'}
          </div>
          <div className="text-xs text-gray-500">
            支持图片（JPG/PNG/HEIC）、Excel (XLSX/XLS/CSV)、PDF · 可同时选择多个文件
          </div>
          <div className="text-xs text-gray-400 mt-2">
            上传后 Claude Sonnet Vision 自动识别，每张约 20-40 秒
          </div>
        </label>
        {uploading && (
          <div className="mt-4">
            <div className="h-2 bg-white rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-600 transition-all"
                style={{ width: `${(uploadProgress.done / uploadProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* 状态 tab */}
      <div className="flex items-center gap-2 flex-wrap">
        {(['pending_review', 'needs_edit', 'confirmed', 'rejected', 'all'] as Status[]).map(s => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`text-xs px-3 py-1.5 rounded-full border transition-all ${
              status === s
                ? 'bg-indigo-600 text-white border-indigo-600'
                : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            {s === 'all' ? '全部' : STATUS_LABELS[s]} ({counts[s === 'all' ? 'all' : s] || 0})
          </button>
        ))}
      </div>

      {/* 样本列表 */}
      {loading ? (
        <div className="text-center py-12 text-gray-400 text-sm">加载中...</div>
      ) : samples.length === 0 ? (
        <div className="text-center py-12 text-gray-400 text-sm">
          暂无{STATUS_LABELS[status] || '全部'}样本
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {samples.map(s => (
            <div
              key={s.id}
              onClick={() => setSelectedSample(s)}
              className="bg-white rounded-xl border border-gray-200 overflow-hidden cursor-pointer hover:shadow-md transition-all"
            >
              {s.source_type === 'image' && s.source_file_url ? (
                <div className="h-40 bg-gray-100 flex items-center justify-center overflow-hidden">
                  <img
                    src={s.source_file_url}
                    alt={s.source_file_name}
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : (
                <div className="h-40 bg-gray-50 flex items-center justify-center text-4xl">
                  {s.source_type === 'excel' ? '📊' : s.source_type === 'pdf' ? '📄' : '📎'}
                </div>
              )}
              <div className="p-3">
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${STATUS_STYLES[s.status]}`}
                  >
                    {STATUS_LABELS[s.status]}
                  </span>
                  {s.ai_confidence && (
                    <span className="text-[10px] text-gray-400">
                      AI {s.ai_confidence}%
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-700 truncate" title={s.source_file_name}>
                  {s.source_file_name || '未命名'}
                </div>
                {s.garment_type && (
                  <div className="text-xs text-indigo-600 mt-1">
                    {GARMENT_LABELS[s.garment_type]} · ¥{s.total_cmt_rmb?.toFixed(2) || '?'}
                  </div>
                )}
                {s.extraction_error && (
                  <div className="text-[10px] text-red-500 mt-1 truncate">
                    ❌ {s.extraction_error}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 详情弹窗 */}
      {selectedSample && (
        <SampleDetail
          sample={selectedSample}
          onClose={() => setSelectedSample(null)}
          onConfirm={() => handleConfirm(selectedSample.id)}
          onReject={() => handleReject(selectedSample.id)}
          onDelete={() => handleDelete(selectedSample.id)}
          onReExtract={() => handleReExtract(selectedSample.id)}
          onUpdate={() => load()}
        />
      )}
    </div>
  );
}

function SampleDetail({
  sample,
  onClose,
  onConfirm,
  onReject,
  onDelete,
  onReExtract,
  onUpdate,
}: {
  sample: any;
  onClose: () => void;
  onConfirm: () => void;
  onReject: () => void;
  onDelete: () => void;
  onReExtract: () => void;
  onUpdate: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [garmentType, setGarmentType] = useState(sample.garment_type || '');
  const [subtype, setSubtype] = useState(sample.garment_subtype || '');
  const [styleNo, setStyleNo] = useState(sample.style_no || '');
  const [customerName, setCustomerName] = useState(sample.customer_name || '');
  const [factoryName, setFactoryName] = useState(sample.factory_name || '');
  const [totalRmb, setTotalRmb] = useState(sample.total_cmt_rmb || 0);
  const [operations, setOperations] = useState<any[]>(sample.operations || []);
  const [saving, setSaving] = useState(false);

  async function handleSaveAndConfirm() {
    setSaving(true);
    const res = await reviewSample(sample.id, 'confirm', {
      garment_type: garmentType,
      garment_subtype: subtype,
      style_no: styleNo,
      customer_name: customerName,
      factory_name: factoryName,
      total_cmt_rmb: Number(totalRmb),
      operations,
    });
    if (res.error) {
      alert(res.error);
    } else {
      onUpdate();
      onClose();
    }
    setSaving(false);
  }

  function updateOp(i: number, field: 'name' | 'rate', value: any) {
    const next = [...operations];
    next[i] = { ...next[i], [field]: field === 'rate' ? Number(value) : value };
    setOperations(next);
  }

  function addOp() {
    setOperations([...operations, { name: '', rate: 0 }]);
  }

  function removeOp(i: number) {
    setOperations(operations.filter((_, idx) => idx !== i));
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-2xl max-w-4xl w-full max-h-[90vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{sample.source_file_name}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">
            ✕
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 p-6">
          {/* 左：原图 / 文件信息 */}
          <div>
            {sample.source_type === 'image' && sample.source_file_url ? (
              <a href={sample.source_file_url} target="_blank" rel="noopener noreferrer">
                <img
                  src={sample.source_file_url}
                  alt={sample.source_file_name}
                  className="w-full rounded-lg border border-gray-200"
                />
              </a>
            ) : (
              <div className="bg-gray-50 rounded-lg p-6 text-center">
                <div className="text-6xl mb-2">
                  {sample.source_type === 'excel' ? '📊' : sample.source_type === 'pdf' ? '📄' : '📎'}
                </div>
                <a
                  href={sample.source_file_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-indigo-600 hover:underline"
                >
                  下载原文件
                </a>
              </div>
            )}

            {sample.ai_raw_text && (
              <details className="mt-3 text-xs">
                <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                  AI 识别原文（供校对）
                </summary>
                <pre className="mt-2 whitespace-pre-wrap text-gray-600 bg-gray-50 p-3 rounded max-h-48 overflow-auto font-sans">
                  {sample.ai_raw_text}
                </pre>
              </details>
            )}

            {sample.extraction_error && (
              <div className="mt-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded p-3">
                ❌ 提取错误：{sample.extraction_error}
              </div>
            )}
          </div>

          {/* 右：提取结果（可编辑） */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-800">AI 提取结果</h3>
              {sample.ai_confidence && (
                <span className="text-xs text-gray-500">置信度 {sample.ai_confidence}%</span>
              )}
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">品类 *</label>
              <select
                value={garmentType}
                onChange={e => setGarmentType(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm bg-white"
              >
                <option value="">-- 选择 --</option>
                <option value="knit_top">针织上衣</option>
                <option value="knit_bottom">针织下装</option>
                <option value="woven_pants">梭织长裤</option>
                <option value="woven_shorts">梭织短裤</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={subtype}
                onChange={e => setSubtype(e.target.value)}
                placeholder="款型 (tshirt/legging)"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                type="text"
                value={styleNo}
                onChange={e => setStyleNo(e.target.value)}
                placeholder="款号"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <input
                type="text"
                value={customerName}
                onChange={e => setCustomerName(e.target.value)}
                placeholder="客户"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                type="text"
                value={factoryName}
                onChange={e => setFactoryName(e.target.value)}
                placeholder="工厂"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-500 mb-1">整件总价 (RMB) *</label>
              <input
                type="number"
                step="0.01"
                value={totalRmb || ''}
                onChange={e => setTotalRmb(Number(e.target.value))}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
            </div>

            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-500">工序明细（{operations.length} 道）</label>
                <button
                  onClick={addOp}
                  className="text-xs text-indigo-600 hover:text-indigo-700"
                >
                  + 添加
                </button>
              </div>
              <div className="space-y-1 max-h-72 overflow-auto border border-gray-100 rounded-lg p-2">
                {operations.length === 0 ? (
                  <p className="text-xs text-gray-400 text-center py-2">暂无工序</p>
                ) : (
                  operations.map((op, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <input
                        type="text"
                        value={op.name || ''}
                        onChange={e => updateOp(i, 'name', e.target.value)}
                        placeholder="工序名"
                        className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs"
                      />
                      <input
                        type="number"
                        step="0.01"
                        value={op.rate || ''}
                        onChange={e => updateOp(i, 'rate', e.target.value)}
                        placeholder="0.00"
                        className="w-16 rounded border border-gray-200 px-2 py-1 text-xs text-right"
                      />
                      <button
                        onClick={() => removeOp(i)}
                        className="text-red-400 hover:text-red-600 text-sm px-1"
                      >
                        ✕
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="text-xs text-gray-500 text-right mt-1">
                累计：¥{operations.reduce((sum, o) => sum + (Number(o.rate) || 0), 0).toFixed(2)}
              </div>
            </div>

            {/* 操作按钮 */}
            <div className="flex gap-2 pt-2 border-t border-gray-100">
              <button
                onClick={handleSaveAndConfirm}
                disabled={saving || !garmentType || !totalRmb}
                className="flex-1 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50"
              >
                {saving ? '保存中...' : '✅ 保存并确认'}
              </button>
              <button
                onClick={onReject}
                className="px-3 py-2 rounded-lg border border-amber-300 text-amber-700 text-sm hover:bg-amber-50"
              >
                拒绝
              </button>
            </div>
            <div className="flex gap-2">
              <button
                onClick={onReExtract}
                className="flex-1 px-3 py-2 rounded-lg border border-indigo-300 text-indigo-700 text-xs hover:bg-indigo-50"
              >
                🔄 重新识别
              </button>
              <button
                onClick={onDelete}
                className="flex-1 px-3 py-2 rounded-lg border border-red-300 text-red-700 text-xs hover:bg-red-50"
              >
                🗑 彻底删除
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
