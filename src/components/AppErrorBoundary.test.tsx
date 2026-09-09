import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AppErrorBoundary from './AppErrorBoundary';

function BrokenMarkdownRenderer(): never {
  throw new TypeError('Markdown preview failed');
}

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces a white screen with actionable error details', () => {
    render(<AppErrorBoundary><BrokenMarkdownRenderer /></AppErrorBoundary>);

    expect(screen.getByRole('heading', { name: 'LocalView 遇到错误' })).toBeTruthy();
    expect(screen.getByTestId('app-error-details').textContent).toContain('TypeError: Markdown preview failed');
    expect(screen.getByTestId('app-error-details').textContent).toContain('User agent:');
  });
});
