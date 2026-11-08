import { describe, expect, it } from 'vitest';
import { audioStatus, audioStatusTitle } from './audioStatus';

describe('audioStatus', () => {
  it('is starting until the engine exists', () => {
    expect(audioStatus({ engine: false, state: null, error: null })).toEqual({ kind: 'starting' });
  });
  it('is paused while the context is suspended (no gesture yet)', () => {
    expect(audioStatus({ engine: true, state: 'suspended', error: null })).toEqual({ kind: 'paused' });
  });
  it('is running once the context runs', () => {
    expect(audioStatus({ engine: true, state: 'running', error: null })).toEqual({ kind: 'running' });
  });
  it('is not running while an old context closes', () => {
    expect(audioStatus({ engine: true, state: 'closed', error: null })).toEqual({ kind: 'paused' });
  });
  it('a start or resume error wins, with or without an engine', () => {
    expect(audioStatus({ engine: false, state: null, error: 'no worklet' })).toEqual({ kind: 'failed', error: 'no worklet' });
    expect(audioStatus({ engine: true, state: 'running', error: 'x' })).toEqual({ kind: 'failed', error: 'x' });
  });
  it('the failed tooltip carries the error', () => {
    expect(audioStatusTitle({ kind: 'failed', error: 'NotAllowedError' })).toContain('NotAllowedError');
  });
});
