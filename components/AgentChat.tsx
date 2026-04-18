'use client';

import { useState, useRef, useEffect } from 'react';
import { askAgent, type ChatMessage } from '@/app/actions/agent-chat';

interface Message {
  role: 'user' | 'agent';
  content: string;
  timestamp: Date;
}

const QUICK_QUESTIONS = [
  { label: '📋 今日待办', q: '今天有哪些待办？' },
  { label: '⚠ 超期风险', q: '哪些订单有超期风险？' },
  { label: '💰 收款状态', q: '有哪些订单尾款逾期了？' },
  { label: '🏭 工厂产能', q: '目前各工厂的产能和历史表现如何？' },
  { label: '📦 FOB vs DDP', q: 'FOB和DDP的区别？报价时分别要包含哪些费用？' },
  { label: '✉ 帮我写邮件', q: '客户问交期能不能提前一周，请帮我写一封专业的回复邮件' },
  { label: '🧵 面料术语', q: 'GSM、纱支、色牢度分别是什么？客户问到怎么专业回答？' },
  { label: '🔍 验货标准', q: 'AQL 2.5是什么意思？中查和尾查分别检查什么？' },
  { label: '🏷 RN号是什么', q: '客户要求提供RN号，RN号是什么？怎么查询？洗标上怎么标注？' },
  { label: '📄 洗标要求', q: '美国市场的洗标要求是什么？必须标注哪些信息？' },
  { label: '💳 付款方式', q: 'T/T、L/C、D/P的区别？各自的风险是什么？' },
  { label: '👶 童装法规', q: '出口美国的童装需要什么认证？CPSIA是什么？' },
];

/**
 * 简单 Markdown → JSX 渲染器
 * 支持：**bold**、`code`、### 标题、- 列表项、空行分段
 */
function MarkdownLine({ text }: { text: string }) {
  // 解析行内的 **bold** 和 `code`
  const parts: React.ReactNode[] = [];
  let rest = text;
  let key = 0;

  while (rest.length > 0) {
    const boldIdx = rest.indexOf('**');
    const codeIdx = rest.indexOf('`');

    // 找最近的标记
    const firstIdx = boldIdx === -1 ? codeIdx : codeIdx === -1 ? boldIdx : Math.min(boldIdx, codeIdx);

    if (firstIdx === -1) {
      parts.push(rest);
      break;
    }

    if (firstIdx > 0) {
      parts.push(rest.slice(0, firstIdx));
    }

    if (firstIdx === boldIdx) {
      const end = rest.indexOf('**', boldIdx + 2);
      if (end === -1) { parts.push(rest.slice(boldIdx)); break; }
      parts.push(<strong key={key++} className="font-semibold">{rest.slice(boldIdx + 2, end)}</strong>);
      rest = rest.slice(end + 2);
    } else {
      const end = rest.indexOf('`', codeIdx + 1);
      if (end === -1) { parts.push(rest.slice(codeIdx)); break; }
      parts.push(<code key={key++} className="px-1 py-0.5 bg-gray-100 rounded text-xs font-mono">{rest.slice(codeIdx + 1, end)}</code>);
      rest = rest.slice(end + 1);
    }
  }

  return <>{parts}</>;
}

function MarkdownRenderer({ content }: { content: string }) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let listItems: React.ReactNode[] = [];
  let idx = 0;

  function flushList() {
    if (listItems.length > 0) {
      elements.push(
        <ul key={`ul-${idx++}`} className="my-1.5 ml-2 space-y-0.5">
          {listItems}
        </ul>
      );
      listItems = [];
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // h3 (### or ##)
    if (/^###?\s+/.test(line)) {
      flushList();
      const text = line.replace(/^###?\s+/, '');
      elements.push(
        <p key={idx++} className="text-xs font-bold text-gray-700 mt-2 mb-0.5 uppercase tracking-wide">
          <MarkdownLine text={text} />
        </p>
      );
      continue;
    }

    // 水平分割线
    if (/^---+$/.test(line.trim())) {
      flushList();
      elements.push(<hr key={idx++} className="my-2 border-gray-200" />);
      continue;
    }

    // 列表项（- 或 • 或 数字.）
    const listMatch = line.match(/^(\s*[-•*]|\s*\d+\.)\s+(.+)/);
    if (listMatch) {
      listItems.push(
        <li key={`li-${idx++}`} className="flex gap-1.5 text-sm">
          <span className="mt-1 w-1 h-1 rounded-full bg-indigo-400 shrink-0" />
          <span><MarkdownLine text={listMatch[2]} /></span>
        </li>
      );
      continue;
    }

    // 空行
    if (line.trim() === '') {
      flushList();
      // 不额外加空行元素，段落间距由内容决定
      continue;
    }

    // 普通段落
    flushList();
    elements.push(
      <p key={idx++} className="text-sm leading-relaxed">
        <MarkdownLine text={line} />
      </p>
    );
  }

  flushList();

  return <div className="space-y-1">{elements}</div>;
}

export function AgentChat({ userName }: { userName: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function handleSend(question?: string) {
    const q = (question || input).trim();
    if (!q || loading) return;

    const userMsg: Message = { role: 'user', content: q, timestamp: new Date() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    // 构建历史（不含刚添加的当前消息）
    const history: ChatMessage[] = messages.map(m => ({
      role: m.role,
      content: m.content,
    }));

    const result = await askAgent(q, history);

    setMessages(prev => [...prev, {
      role: 'agent',
      content: result.error || result.answer,
      timestamp: new Date(),
    }]);
    setLoading(false);

    // 回复完成后聚焦输入框
    setTimeout(() => inputRef.current?.focus(), 100);
  }

  function handleClear() {
    setMessages([]);
    setInput('');
  }

  return (
    <div className="flex flex-col h-[calc(100vh-140px)]">
      {/* 头部 */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex-1 text-center">
          <div className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-50 rounded-full">
            <span className="text-lg">🤖</span>
            <span className="text-sm font-medium text-indigo-700">小绮 · AI 业务助手</span>
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
          </div>
          <p className="text-xs text-gray-400 mt-1.5">订单查询 · 行业知识 · 客户画像 · 邮件回复 · 多轮对话</p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClear}
            className="text-xs text-gray-400 hover:text-gray-600 px-2 py-1 rounded hover:bg-gray-100 transition-colors shrink-0"
          >
            清空
          </button>
        )}
      </div>

      {/* 消息区 */}
      <div className="flex-1 overflow-y-auto space-y-4 px-1">
        {messages.length === 0 && (
          <div className="text-center py-8">
            <p className="text-gray-500 mb-5">你好 {userName}，有什么我可以帮你的？</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 max-w-xl mx-auto">
              {QUICK_QUESTIONS.map(item => (
                <button
                  key={item.q}
                  onClick={() => handleSend(item.q)}
                  className="px-3 py-2.5 text-xs rounded-xl border border-indigo-200 text-indigo-600 hover:bg-indigo-50 transition-colors text-left leading-snug"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[82%] rounded-2xl px-4 py-3 ${
              msg.role === 'user'
                ? 'bg-indigo-600 text-white'
                : 'bg-white border border-gray-200 text-gray-900 shadow-sm'
            }`}>
              {msg.role === 'agent' && (
                <span className="text-xs text-indigo-500 font-medium block mb-1.5">🤖 小绮</span>
              )}
              {msg.role === 'agent' ? (
                <MarkdownRenderer content={msg.content} />
              ) : (
                <p className="text-sm leading-relaxed">{msg.content}</p>
              )}
              <p className={`text-xs mt-1.5 ${msg.role === 'user' ? 'text-indigo-200' : 'text-gray-300'} text-right`}>
                {msg.timestamp.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-white border border-gray-200 rounded-2xl px-4 py-3 shadow-sm">
              <span className="text-xs text-indigo-500 font-medium block mb-1.5">🤖 小绮</span>
              <div className="flex gap-1.5 items-center">
                <span className="w-2 h-2 bg-indigo-300 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                <span className="w-2 h-2 bg-indigo-300 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                <span className="w-2 h-2 bg-indigo-300 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                <span className="text-xs text-gray-400 ml-1">正在思考...</span>
              </div>
            </div>
          </div>
        )}

        {/* 快捷问题（有对话时也显示，在底部） */}
        {messages.length > 0 && messages.length <= 2 && !loading && (
          <div className="flex flex-wrap gap-1.5 justify-center pt-1">
            {QUICK_QUESTIONS.slice(0, 6).map(item => (
              <button
                key={item.q}
                onClick={() => handleSend(item.q)}
                className="px-2.5 py-1 text-xs rounded-full border border-gray-200 text-gray-500 hover:border-indigo-200 hover:text-indigo-600 hover:bg-indigo-50 transition-colors"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="mt-4">
        {/* 对话轮次提示 */}
        {messages.length > 0 && (
          <p className="text-xs text-gray-400 mb-1.5 text-center">
            本次对话 {Math.ceil(messages.length / 2)} 轮 · 小绮会记住上下文
          </p>
        )}
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder="问订单进度、行业知识、帮写邮件..."
            disabled={loading}
            className="flex-1 rounded-2xl border border-gray-300 px-4 py-3 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-50"
          />
          <button
            onClick={() => handleSend()}
            disabled={loading || !input.trim()}
            className="px-5 py-3 rounded-2xl bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors shrink-0"
          >
            {loading ? '...' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
