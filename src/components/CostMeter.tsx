// Monthly cost against the budget. Illustrative units, not real prices
// (PLAN_DESIGN_CHALLENGES.md §2).
export default function CostMeter({ cost, budget }: { cost: number; budget: number }) {
  const over = cost > budget
  const fill = Math.min(100, (cost / budget) * 100)
  return (
    <div className="min-w-48 flex-1">
      <div className="mb-1 flex justify-between text-sm">
        <span id="cost-label" className="text-muted">
          Monthly cost
        </span>
        <span className={`font-mono tabular-nums ${over ? 'text-crit' : ''}`}>
          {cost} / {budget} units{over && ' · over budget'}
        </span>
      </div>
      <div
        role="meter"
        aria-labelledby="cost-label"
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={cost}
        aria-valuetext={`${cost} of ${budget} units${over ? ', over budget' : ''}`}
        className="h-2 overflow-hidden rounded-full bg-line"
      >
        {/* scaleX instead of width: animates on the compositor, no layout work. The track's rounding clips it. */}
        <div
          className={`h-full origin-left ${over ? 'bg-crit' : fill > 85 ? 'bg-warn' : 'bg-accent'}`}
          style={{ transform: `scaleX(${fill / 100})`, transition: 'transform 200ms' }}
        />
      </div>
    </div>
  )
}
