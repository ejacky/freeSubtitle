import { describe, expect, it } from 'vitest';
import { arrayBufferToBase64, base64ToArrayBuffer } from '../src/lib/base64';

describe('base64 audio transport', () => {
  it('round-trips binary data', () => {
    const source = new Uint8Array(70_000);
    for (let i = 0; i < source.length; i++) source[i] = i % 256;
    const encoded = arrayBufferToBase64(source.buffer);
    const decoded = new Uint8Array(base64ToArrayBuffer(encoded));
    expect(decoded.length).toBe(source.length);
    expect(decoded[0]).toBe(0);
    expect(decoded[65535]).toBe(255);
    expect(decoded[69_999]).toBe(69_999 % 256);
  });

  it('handles an empty buffer', () => {
    const encoded = arrayBufferToBase64(new ArrayBuffer(0));
    expect(encoded).toBe('');
    expect(base64ToArrayBuffer('').byteLength).toBe(0);
  });
});
