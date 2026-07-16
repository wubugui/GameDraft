import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';

/**
 * 顶层错误边界（P1-07）：任一子组件渲染抛错时不再白屏——显示中文崩溃页，
 * 并把最近一次画布草稿（window.__narrativeEditorLastDraft，由 NarrativeEditorApp
 * 每次数据变化时刷新、卸载不清除）展示出来供复制备份。
 *
 * 同时置 window.__narrativeEditorCrashed = true：PySide 宿主壳的 flush_to_model
 * 据此把「读不到 __narrativeEditor」当失败上报（而非假装保存成功）。
 *
 * 注意：不用下载文件方案——QWebEngine 宿主未接 downloadRequested，blob 下载会被
 * 静默吞掉；「全选复制 + 可见文本框」在嵌入端与浏览器端都可靠。
 */
type EditorErrorBoundaryProps = { children: ReactNode };
type EditorErrorBoundaryState = { error: Error | null; copied: boolean };

export class EditorErrorBoundary extends Component<EditorErrorBoundaryProps, EditorErrorBoundaryState> {
  state: EditorErrorBoundaryState = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<EditorErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    window.__narrativeEditorCrashed = true;
    console.error('[narrative-editor] 页面崩溃：', error, info.componentStack);
  }

  private draftJson(): string {
    return typeof window.__narrativeEditorLastDraft === 'string' ? window.__narrativeEditorLastDraft : '';
  }

  private copyDraft = (): void => {
    const text = this.draftJson();
    if (!text) return;
    const fallbackCopy = () => {
      const area = document.getElementById('narrative-crash-draft') as HTMLTextAreaElement | null;
      if (!area) return;
      area.focus();
      area.select();
      document.execCommand('copy');
      this.setState({ copied: true });
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(
        () => this.setState({ copied: true }),
        fallbackCopy,
      );
    } else {
      fallbackCopy();
    }
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    const draft = this.draftJson();
    const box: CSSProperties = {
      minHeight: '100vh',
      boxSizing: 'border-box',
      padding: '32px 40px',
      background: '#191b1f',
      color: '#e6edf3',
      fontFamily: 'system-ui, sans-serif',
      display: 'flex',
      flexDirection: 'column',
      gap: 12,
    };
    return (
      <div style={box}>
        <h2 style={{ margin: 0, color: '#f87171' }}>叙事编辑器页面崩溃了</h2>
        <p style={{ margin: 0, lineHeight: 1.6 }}>
          页面内部出现了未处理的错误，画布已停止响应。<b>你的最近草稿快照仍在下方</b>——
          若其中包含尚未暂存（未 Ctrl+S）的修改，请先点「复制草稿 JSON」备份，再重载页面。
          重载后画布会回到主编辑器工程模型里的最新暂存内容。
        </p>
        <pre
          style={{
            margin: 0,
            padding: '8px 10px',
            background: '#0d1117',
            color: '#fca5a5',
            borderRadius: 6,
            whiteSpace: 'pre-wrap',
            maxHeight: 120,
            overflow: 'auto',
            fontSize: 12,
          }}
        >
          {String(this.state.error?.stack || this.state.error)}
        </pre>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button type="button" onClick={this.copyDraft} disabled={!draft} style={{ padding: '6px 14px' }}>
            复制草稿 JSON
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{ padding: '6px 14px' }}
            title="重载会清空本页的草稿快照——请先复制备份"
          >
            重载页面（先复制备份！）
          </button>
          {this.state.copied ? <span style={{ color: '#4ade80' }}>已复制到剪贴板</span> : null}
        </div>
        {draft ? (
          <textarea
            id="narrative-crash-draft"
            readOnly
            value={draft}
            style={{
              flex: 1,
              minHeight: 220,
              background: '#0d1117',
              color: '#c9d3dc',
              border: '1px solid #30363d',
              borderRadius: 6,
              padding: 10,
              fontFamily: 'ui-monospace, monospace',
              fontSize: 12,
            }}
          />
        ) : (
          <p style={{ margin: 0, color: '#9ca3af' }}>
            没有可用的草稿快照（页面尚未完成首次加载即崩溃）。工程模型里已暂存的内容不受影响。
          </p>
        )}
        <p style={{ margin: 0, color: '#9ca3af', fontSize: 12 }}>
          草稿同时保存在 window.__narrativeEditorLastDraft，可在开发者工具里读取；
          问题可复现时请把上方错误信息一并反馈。
        </p>
      </div>
    );
  }
}
