// Shared test setup. UI tests wait for lazy-loaded screens and content
// chunks; on a cold CI runner the first load has taken over 5 seconds, far
// more than Testing Library's default 1 s wait. With two or three full runs
// at once on one machine (TF5), the first lazy screen in a file took over
// 10 s to transform and appear, so allow 30 (vite.config.ts keeps the
// per-test limit above this).
import { configure } from '@testing-library/react'

configure({ asyncUtilTimeout: 30_000 })

// jsdom's TextEncoder hands back a Uint8Array from another realm, which the
// shell library (just-bash) doesn't recognise with instanceof. Copy each result
// into this realm's Uint8Array, as a browser's single realm would give.
import { TextDecoder, TextEncoder as NodeTextEncoder } from 'node:util'
class TextEncoder {
  readonly encoding = 'utf-8'
  private inner = new NodeTextEncoder()
  encode(input = '') {
    return new Uint8Array(this.inner.encode(input))
  }
  encodeInto(input: string, dest: Uint8Array) {
    return this.inner.encodeInto(input, dest)
  }
}
Object.assign(globalThis, { TextEncoder, TextDecoder })
