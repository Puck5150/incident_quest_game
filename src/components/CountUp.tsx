import { useEffect, useState } from 'react'

const motionReduced = () =>
  document.documentElement.classList.contains('reduce-motion') ||
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// Counts from 0 to `value` with an ease-out curve. Screen readers get the
// final number straight away; with reduced motion everyone does.
export default function CountUp({ value, ms = 900, delay = 250 }: { value: number; ms?: number; delay?: number }) {
  const [reduced] = useState(motionReduced)
  const [shown, setShown] = useState(0)

  useEffect(() => {
    if (reduced) return
    let raf = 0
    const start = performance.now() + delay
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / ms))
      setShown(Math.round(value * (1 - (1 - t) ** 3)))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [reduced, value, ms, delay])

  return (
    <>
      <span aria-hidden className="tabular-nums">
        {reduced ? value : shown}
      </span>
      <span className="sr-only">{value}</span>
    </>
  )
}
