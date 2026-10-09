// SPDX-License-Identifier: Apache-2.0
// Byte helpers the builder and the checker share.

export const encoder = new TextEncoder();

/** Where `needle` first occurs in `haystack` at or after `from`, or -1. */
export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const last = haystack.length - needle.length;
  for (let i = haystack.indexOf(needle[0], from); i !== -1 && i <= last; i = haystack.indexOf(needle[0], i + 1)) {
    let j = 1;
    while (j < needle.length && haystack[i + j] === needle[j]) j++;
    if (j === needle.length) return i;
  }
  return -1;
}

export const equalBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
