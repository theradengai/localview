import { describe, expect, it, vi } from 'vitest';
import { runTreeBatch } from './treeSelection';

describe('batch failure accounting', () => {
  it('retains confirmed progress when a later operation rejects', async () => {
    const operate = vi.fn(async (item: number) => {
      if (item === 2) throw new Error('native commit outcome uncertain');
      return { ok: true as const };
    });
    await expect(runTreeBatch([1, 2, 3], operate)).resolves.toEqual({
      completed: [1], remaining: [2, 3], failure: 'native commit outcome uncertain',
    });
    expect(operate.mock.calls.map(([item]) => item)).toEqual([1, 2]);
  });

  it.each([undefined, null, {}, '', '   '])('fails closed for a non-diagnostic rejection (%j)', async (error) => {
    const operate = vi.fn(async () => { throw error; });
    const result = await runTreeBatch(['a', 'b'], operate);
    expect(result.completed).toEqual([]);
    expect(result.remaining).toEqual(['a', 'b']);
    expect(result.failure).toBeTruthy();
    expect(operate).toHaveBeenCalledOnce();
  });

  it('preserves a string rejection and never starts remaining operations', async () => {
    const operate = vi.fn(async () => { throw 'WORKSPACE_CHANGED'; });
    await expect(runTreeBatch([1, 2], operate)).resolves.toEqual({
      completed: [], remaining: [1, 2], failure: 'WORKSPACE_CHANGED',
    });
    expect(operate).toHaveBeenCalledOnce();
  });

  it.each(['', '   '])('never lets an empty failure message look like success (%j)', async (message) => {
    const operate = vi.fn(async (item: number) => item === 2
      ? { ok: false as const, message } : { ok: true as const });
    const result = await runTreeBatch([1, 2, 3], operate);
    expect(result.completed).toEqual([1]);
    expect(result.remaining).toEqual([2, 3]);
    expect(result.failure).toBeTruthy();
    expect(operate.mock.calls.map(([item]) => item)).toEqual([1, 2]);
  });
});
