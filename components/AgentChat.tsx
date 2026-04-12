'use client';

import { useState, useRef, useEffect } from 'react';
import { askAgent } from '@/app/actions/agent-chat';

interface Message {
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
}

const QUICK_QUESTIONS = [
  { label: '📋 今日待办', q: '今天有哪些待办？' },
  { label: '⚠ 超期风险', q: '哪些订单有超期风险？' },
  { label: '🏷 RN号是什么', q: '客户要求提供RN号，RN号是什么？怎么查询？洗标上怎么标注？' },
  { label: '📦 FOB vs DDP', q: 'FOB和DDP的区别？报价时分别要包含哪些费用？' },
  { label: '✉ 帮我写邮件', q: '客户问交期能不能提前一周，请帮我写一封专业的回复邮件' },
  { label: '🧵 面料术语', q: 'GSM、纱支、色牢度分别是什么？客户问到怎么专业回答？' },
  { label: '📐 尺码对照', q: '美码/欧码/日码的对照关系？Plus size从哪个码开始？' },
  { label: '🔍 验货标准', q: 'AQL 2.5是什么意思？中查和尾查分别检查什么？' },
  { label: '📄 洗标要求', q: '美国市场的洗标要求是什么？必须标注哪些信息？' },
  { label: '🚢 集装箱规格', q: '20GP/40GP/40HQ分别能装多少件衣服？怎么计算？' },
  { label: '💳 付款方式', q: 'T/T、L/C、D/P的区别？各自的风险是什么？' },
  { label: '👶 童装法规', q: '出口美国的童装需要什么认证？CPSIA是什么？' },
];

export function AgentChat({ userName }: { userName: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(question?: string) {
    const q = (question || input).trim();
    if (!q || loading) return;

    setMessages(prev => [...prev, { role: 'user', content: q, timestamp: new Date() }]);
    setInput('');
    setLoading(true);

    const result = await askAgent(q);

    setMessages(prev => [...prev, {
      role: 'agent',
      content: result.error || result.answer,
      timestamp: new Date(),
    }]);
    setLoading(false);
  }

  return (
    <div className="flex flex-col h-[calc(100vh-140px)]">
      {/* 头部 */}
      <div className="text-center mb-4">
        <div className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-50 rounded-full">
          <span className="text-lg">🤖</span>
          <span className="text-sm font-medium text-indigo-700">小绮 · AI 业务助手</span>
        </div>
        <p className="text-xs text-gray-400 mt-2">订单查询 · 行业知识 · 客户回复建议 · 面料/工艺/贸易专业咨询</p>
      </div>

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto space-y-4 px-2">
        {messages.length === 0 && (
          <div className="text-center py-12">
            <p className="text-gray-500 mb-6">你好 {userName}，有什么我可以帮你的？</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-w-lg mx-auto">
              {QUICK_QUESTIONS.map(item => (
                <button key={item.q} onClick={() => handleSend(item.q)}
                  className="px-3 py-2.5 text-xs rounded-xl border border-indigo-200 text-indigo-600 hover:bg-indigo-50 transition-colors text-left">
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] rounded-2xl px-4 py-3 ${
              msg.role === 'user'
                ? 'bg-indigo-600 text-white'
                : 'bg-white border border-gray-200 text-gray-900'
            }`}>
              {msg.role === 'agent' && <span className="text-xs text-indigo-500 font-medium block mb-1">🤖 小绮</span>}
              <p className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</p>
              <p className={`text-xs mt-1 ${msg.role === 'user' ? 'text-indigo-200' : 'text-gray-300'}`}>
                {msg.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3">
              <span className="text-xs text-indigo-500 font-medium block mb-1">🤖 小绮</span>
              <div className="flex gap-1">
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-gray-300 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="mt-4 flex gap-2">
        <input
          type="text"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="问我任何关于订单的问题..."
          disabled={loading}
          className="flex-1 rounded-2xl border border-gray-300 px-4 py-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50"
        />
        <button
          onClick={() => handleSend()}
          disabled={loading || !input.trim()}
          className="px-5 py-3 rounded-2xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors shrink-0"
        >
          {loading ? '...' : '发送'}
        </button>
      </div>
    </div>
  );
}
