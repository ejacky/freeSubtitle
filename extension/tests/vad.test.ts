import { describe, expect, it } from 'vitest';
import { VadSegmenter } from '../src/offscreen/vad';
import type { VadConfig } from '../src/lib/messaging/protocol';

const CONFIG: VadConfig = {
  frameMs: 20,
  startFrames: 3,
  silenceMs: 600,
  minSpeechMs: 300,
  maxSegmentMs: 8000,
  preRollMs: 200,
  postRollMs: 300,
};

function tone(seconds: number, amplitude = 0.2): Float32Array {
  const n = Math.round(16000 * seconds);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * amplitude;
  return out;
}

function silence(seconds: number): Float32Array {
  return new Float32Array(Math.round(16000 * seconds));
}

describe('VadSegmenter', () => {
  it('ignores pure silence', () => {
    const segments: unknown[] = [];
    const vad = new VadSegmenter(CONFIG, (segment) => segments.push(segment));
    vad.push(silence(3));
    vad.flush();
    expect(segments).toHaveLength(0);
  });

  it('extracts one segment from silence + speech + silence', () => {
    const segments: { samples: Float32Array; t0: number; t1: number; rms: number }[] = [];
    const vad = new VadSegmenter(CONFIG, (segment) => segments.push(segment));
    vad.push(silence(1));
    vad.push(tone(2));
    vad.push(silence(1));
    vad.flush();
    expect(segments.length).toBeGreaterThanOrEqual(1);
    const segment = segments[0]!;
    expect(segment.samples.length).toBeGreaterThan(16000);
    expect(segment.rms).toBeGreaterThan(0.05);
    expect(segment.t0).toBeGreaterThan(0.5);
    expect(segment.t1).toBeGreaterThan(segment.t0);
  });

  it('splits very long continuous speech', () => {
    const segments: unknown[] = [];
    const vad = new VadSegmenter(CONFIG, (segment) => segments.push(segment));
    for (let i = 0; i < 12; i++) vad.push(tone(1));
    vad.flush();
    expect(segments.length).toBeGreaterThanOrEqual(2);
  });
});
