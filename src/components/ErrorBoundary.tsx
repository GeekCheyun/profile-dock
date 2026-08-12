import { Component, type ErrorInfo, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  componentStack: string
}

/**
 * 全局错误边界：捕获任意子组件渲染期的异常，
 * 渲染一个带错误信息的卡片而非整窗空白（配合 index.html 的“正在加载”占位，
 * 即使 React 挂载/渲染失败，也能给用户可读的反馈）。
 */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, componentStack: '' }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ error, componentStack: info.componentStack || '' })
    console.error('[多开工具][ErrorBoundary] 渲染异常:', error, info)
  }

  private handleRetry = () => {
    this.setState({ error: null, componentStack: '' })
  }

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    return (
      <div className="min-h-full flex items-center justify-center p-8">
        <div className="w-full max-w-xl rounded-lg border border-red-200 bg-red-50 p-6">
          <h2 className="text-lg font-semibold text-red-700">应用出错了</h2>
          <p className="mt-1 text-sm text-red-600">{error.message || String(error)}</p>
          {componentStack ? (
            <pre className="mt-4 max-h-64 overflow-auto rounded bg-white/70 p-3 text-xs text-red-500 whitespace-pre-wrap">
              {componentStack}
            </pre>
          ) : null}
          <button
            type="button"
            className="mt-4 rounded border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-100"
            onClick={this.handleRetry}
          >
            重试
          </button>
        </div>
      </div>
    )
  }
}
