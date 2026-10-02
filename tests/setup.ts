// Shared test setup. UI tests wait for lazy-loaded screens and content
// chunks; on a cold CI runner the first load has taken over 5 seconds, far
// more than Testing Library's default 1 s wait, so allow 10 (vite.config.ts
// keeps the per-test limit above this).
import { configure } from '@testing-library/react'

configure({ asyncUtilTimeout: 10_000 })
