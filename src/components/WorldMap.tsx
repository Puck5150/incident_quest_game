import type { KeyboardEvent } from 'react'
import type { Track } from '../schema/scenario.ts'

// The ops-room wall: a dot-matrix world with one station per sector.
// Stations come from tracks.yaml (`station`); lights show locked, open
// missions (pulsing) or all clear. Selecting one jumps to that sector.

// Land cells, 5 degrees each, from 75N (top) to 55S, 180W to 180E.
// Hand-drawn and stylised: it's a wall display, not a GIS layer.
const LAND = [
  '............##########..#########...............#################.......',
  '...######.#############..#######........################################',
  '...#####################..####..##....##################################',
  '.....###################...#.........#################################..',
  '..........###############..........##################################...',
  '...........###############.........##############################.......',
  '...........#############...........############################.#.......',
  '...........###########............###.##.#####################..#.......',
  '............#########.............#####....##################..#........',
  '.............#######..............###########################...........',
  '..............###...#............###############..#####.#####...........',
  '...............####.............################..####.####.............',
  '.................###............##############.....##..###..#...........',
  '...................######........##############....#...###..#...........',
  '....................#######.......############..........####............',
  '....................#######...........#######...........####............',
  '....................##########........#######............##.#####.......',
  '....................#########.........#######.................#####.....',
  '.....................########.........########...............#####......',
  '......................######..........######.#.............########.....',
  '......................#####............####...............#########.....',
  '.....................#####.............####................########.....',
  '.....................####......................................####...#.',
  '.....................###.........................................#....##',
  '.....................##...............................................#.',
  '.....................##.................................................',
  '......................#.................................................',
]
const CELL = 10 // px per 5 degrees
const W = 72 * CELL
const H = LAND.length * CELL
const x = (lon: number) => ((lon + 180) / 5) * CELL + CELL / 2
const y = (lat: number) => ((75 - lat) / 5) * CELL + CELL / 2

export type Sector = { track: Track; open: number; total: number; locked: boolean }

export default function WorldMap({
  sectors,
  onSelect,
  title = 'Ops wall',
}: {
  sectors: Sector[]
  onSelect?: (id: string) => void // without it, stations are display only
  title?: string
}) {
  const shown = sectors.filter((s) => s.track.station)
  return (
    <section aria-labelledby="map-h" className="rounded-lg border border-line bg-panel p-4">
      <h2 id="map-h">{title}</h2>
      <svg viewBox={`0 0 ${W} ${H}`} className="mt-3 w-full" role="group" aria-label="Sector stations">
        <g aria-hidden className="fill-line">
          {LAND.flatMap((row, r) =>
            [...row].map((c, i) => (c === '#' ? <circle key={`${r}-${i}`} cx={i * CELL + CELL / 2} cy={r * CELL + CELL / 2} r={1.8} /> : null)),
          )}
        </g>
        {shown.map(({ track, open, total, locked }) => {
          const { city, lat, lon, side } = track.station!
          const state = locked ? 'locked' : open ? 'open' : 'clear'
          const color = { locked: 'var(--muted)', open: 'var(--warn)', clear: 'var(--ok)' }[state]
          const status = locked ? 'locked' : open ? `${open} of ${total} missions open` : 'all clear'
          const select = () => onSelect?.(track.id)
          const interactive = onSelect
            ? {
                role: 'button',
                tabIndex: 0,
                onClick: select,
                onKeyDown: (e: KeyboardEvent) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), select()),
              }
            : { role: 'img' }
          const left = side === 'left'
          return (
            <g
              key={track.id}
              {...interactive}
              aria-label={`${track.name}, ${city} station: ${status}`}
              className={`group outline-none ${onSelect ? 'cursor-pointer' : ''}`}
            >
              <title>{`${city} station`}</title>
              {state === 'open' && <circle cx={x(lon)} cy={y(lat)} r={5} fill="none" stroke={color} className="map-ping" />}
              <circle cx={x(lon)} cy={y(lat)} r={5} fill={color} opacity={locked ? 0.5 : 1} />
              <circle
                cx={x(lon)}
                cy={y(lat)}
                r={10}
                fill="none"
                stroke="var(--accent)"
                strokeWidth={2}
                className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
              />
              <text
                x={x(lon) + (left ? -9 : 9)}
                y={y(lat) + 4}
                textAnchor={left ? 'end' : 'start'}
                className="hidden fill-fg font-mono text-[11px] tracking-wider uppercase sm:inline" // too small to read on phones; the aria-label still names it
              >
                {track.name}
              </text>
            </g>
          )
        })}
      </svg>
    </section>
  )
}
