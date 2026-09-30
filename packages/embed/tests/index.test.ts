import { describe, it, expect } from 'vitest';
import { initEmbed, SurfaceResizeObserver } from '../src/index.js';

describe('embed index re-exports', () => {
  it('exports initEmbed and SurfaceResizeObserver', () => {
    expect(typeof initEmbed).toBe('function');
    expect(typeof SurfaceResizeObserver).toBe('function');
  });
});
