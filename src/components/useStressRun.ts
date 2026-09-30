import { useEffect, useRef, useState } from 'react'
import { motionReduced } from '../motion.ts'

const STEP_MS = 700 // time per stress test in the run sequence

// Plays a run's stress tests one at a time. Reduced motion shows them all at once.
export function useStressRun(total: number) {
  const [revealed, setRevealed] = useState(0)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const running = total > 0 && revealed < total

  useEffect(() => {
    if (!running) return
    const t = setTimeout(() => setRevealed((n) => n + 1), STEP_MS)
    return () => clearTimeout(t)
  }, [running, revealed])

  return {
    revealed,
    running,
    titleRef,
    // Call after recording a new run with `count` tests.
    start(count: number) {
      setRevealed(motionReduced() ? count : 0)
      // Move focus to the results so keyboard and screen-reader users (and
      // phone users, where results sit below the design) land on the outcome.
      requestAnimationFrame(() => titleRef.current?.focus())
    },
    skip: () => setRevealed(total),
  }
}
