import { describe, expect, it } from 'vitest';
import { encodeWav, wavDurationSeconds } from '../src/offscreen/wav';

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono PCM header', () => {
    const samples = new Float32Array(1600);
    samples[0] = 0.5;
    samples[1] = -0.5;
    const buffer = encodeWav(samples);
    const view = new DataView(buffer);
    const ascii = (offset: number, length: number) =>
      String.fromCharCode(...new Uint8Array(buffer, offset, length));

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
    expect(view.byteLength).toBe(44 + samples.length * 2);
    expect(view.getInt16(44, true)).toBeGreaterThan(16000);
    expect(view.getInt16(46, true)).toBeLessThan(-16000);
    expect(wavDurationSeconds(buffer)).toBeCloseTo(0.1, 2);
  });

  it('clamps out-of-range samples', () => {
    const buffer = encodeWav(new Float32Array([2, -2]));
    const view = new DataView(buffer);
    expect(view.getInt16(44, true)).toBe(32767);
    expect(view.getInt16(46, true)).toBe(-32768);
  });
});
