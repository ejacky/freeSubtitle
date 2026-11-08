/** Small, dependency-free hashing helpers used for cache keys and cue ids. */

export async function sha256Hex(input: string): Promise<string> {
  try {
    const data = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return fnv1a(input);
  }
}

export function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function cueId(start: number, end: number, text: string): string {
  return `${start.toFixed(2)}-${end.toFixed(2)}-${fnv1a(text)}`;
}

/** Synchronous short hash for debug/IDs where cryptographic strength is irrelevant. */
export function shortHash(input: string): string {
  return fnv1a(input);
}
