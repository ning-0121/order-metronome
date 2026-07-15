'use client';

/**
 * 标签级错误边界(2026-07-14)——某个 tab 里的组件渲染崩了,只在本区域显示报错 + 重试,
 * 不再把整个订单页拖成「订单加载失败」404。同时把真实错误文案显出来,便于定位根因。
 */

import { Component, type ReactNode } from 'react';

interface Props { children: ReactNode; label?: string }
interface State { error: Error | null }

export class TabErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[TabErrorBoundary]', this.props.label || '', error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm">
          <div className="font-semibold text-rose-700 mb-1">⚠️ {this.props.label || '本模块'}出错了</div>
          <p className="text-rose-600 mb-2">该区域组件渲染异常,已隔离——订单其它功能不受影响。请把下面这行报错发给管理员定位:</p>
          <pre className="text-xs text-rose-500 bg-white/70 rounded p-2 overflow-x-auto whitespace-pre-wrap">{String(this.state.error?.message || this.state.error)}</pre>
          <button onClick={() => this.setState({ error: null })} className="mt-2 px-3 py-1 rounded-lg bg-rose-600 text-white text-xs font-medium hover:bg-rose-700">重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}
