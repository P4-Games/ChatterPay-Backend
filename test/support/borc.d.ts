/**
 * Minimal typings for `borc`, the independent CBOR implementation the certificate suite decodes
 * with. The package ships no types, and only these two entry points are used.
 */
declare module 'borc' {
  export function decodeFirst(input: Buffer | Uint8Array): unknown;
  export function encode(value: unknown): Buffer;
}
