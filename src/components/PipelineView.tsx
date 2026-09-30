import type { Scenario } from '../schema/scenario.ts'
import Browser from './Browser.tsx'
import TextView from './TextView.tsx'
import Icon from './Icon.tsx'

type P = NonNullable<Scenario['pipeline']>

const STATUS = {
  success: { icon: 'check', className: 'text-ok' },
  failure: { icon: 'x', className: 'text-crit' },
  skipped: { icon: 'skip', className: 'text-muted' },
  cancelled: { icon: 'stop', className: 'text-warn' },
} as const

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
            <span className="flex items-center gap-2">
              <span className={STATUS[s.status].className}>
                <Icon name={STATUS[s.status].icon} className="h-3.5 w-3.5" />
                <span className="sr-only">{s.status}: </span>
              </span>
              <span className="flex-1">{s.name}</span>
              {s.duration_s !== undefined && <span className="text-muted tabular-nums">{s.duration_s}s</span>}
            </span>
          ),
          render: () =>
            s.log ? <TextView content={s.log} isLog /> : <p className="p-3 text-sm text-muted">No log output ({s.status}).</p>,
        }))}
      />
    </div>
  )
}
