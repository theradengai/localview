import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
  componentStack: string;
};

function errorDetails(error: Error, componentStack: string): string {
  return [
    `${error.name}: ${error.message}`,
    error.stack,
    componentStack ? `React component stack:\n${componentStack}` : '',
    `User agent: ${navigator.userAgent}`,
  ].filter(Boolean).join('\n\n');
}

export default class AppErrorBoundary extends Component<Props, State> {
  state: State = {
    error: null,
    componentStack: '',
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? '' });
  }

  render() {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;

    return <main style={{ minHeight: '100vh', padding: '48px', background: '#f3f3f0', color: '#181818', fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif' }}>
      <section style={{ maxWidth: '820px', margin: '0 auto', padding: '28px', border: '1px solid #d7d7d1', borderRadius: '12px', background: '#fff' }}>
        <h1 style={{ margin: '0 0 12px', fontSize: '24px' }}>LocalView 遇到错误</h1>
        <p style={{ margin: '0 0 20px', lineHeight: 1.6 }}>你的文件没有被修改。请截图下面的错误信息，用于定位白屏原因。</p>
        <pre data-testid="app-error-details" style={{ margin: 0, padding: '16px', overflow: 'auto', borderRadius: '8px', background: '#161616', color: '#f4f4f4', fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {errorDetails(error, componentStack)}
        </pre>
      </section>
    </main>;
  }
}
