// Shared test setup. UI tests wait for lazy-loaded screens and content
// chunks; on a cold CI runner the first load can take over a second, more
// than Testing Library's default 1 s wait, so allow longer.
import { configure } from '@testing-library/react'

configure({ asyncUtilTimeout: 5000 })
