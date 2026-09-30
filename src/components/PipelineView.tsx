import type { Scenario } from '../schema/scenario.ts'
import Browser from './Browser.tsx'
import TextView from './TextView.tsx'

type P = NonNullable<Scenario['pipeline']>

const STATUS = {
  success: { icon: '✓', className: 'text-ok' },
  failure: { icon: '✕', className: 'text-crit' },
  skipped: { icon: '⊘', className: 'text-muted' },
  cancelled: { icon: '■', className: 'text-warn' },
}

// A CI run: stages in order with status, each opening its own log.
export default function PipelineView({ pipeline, onOpen }: { pipeline: P; onOpen: (name: string) => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm">
        <span className="font-medium">{pipeline.name}</span> <span className="text-muted">· {pipeline.trigger}</span>
      </p>
      <Browser
        noun="stage"
        onOpen={onOpen}
        items={pipeline.stages.map((s) => ({
          name: s.name,
          label: (
            <span className="flex items-baseline gap-2">
              <span className={STATUS[s.status].className}>
                {STATUS[s.status].icon}
                <span className="sr-only"> {s.status}</span>
              </span>
              <span className="flex-1">{s.name}</span>
              {s.duration_s !== undefined && <span className="text-muted">{s.duration_s}s</span>}
            </span>
          ),
          render: () =>
            s.log ? <TextView content={s.log} isLog /> : <p className="p-3 text-sm text-muted">No log output ({s.status}).</p>,
        }))}
      />
    </div>
  )
}
