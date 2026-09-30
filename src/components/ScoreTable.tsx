import type { CSSProperties } from 'react'

// Itemized score; lines tally in one after another (see .anim-rise).
export default function ScoreTable({ lines, total }: { lines: { label: string; xp: number }[]; total: number }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {lines.map((l, i) => (
          <tr
            key={l.label}
            className="anim-rise border-b border-line last:border-0"
            style={{ '--delay': `${300 + Math.min(i, 8) * 60}ms` } as CSSProperties}
          >
            <td className="py-1.5">{l.label}</td>
            <td className={`py-1.5 text-right font-mono tabular-nums ${l.xp < 0 ? 'text-crit' : 'text-ok'}`}>
              {l.xp > 0 ? '+' : ''}
              {l.xp}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th className="pt-2 text-left">Total</th>
          <td className="pt-2 text-right font-mono font-semibold tabular-nums">{total}</td>
        </tr>
      </tfoot>
    </table>
  )
}
