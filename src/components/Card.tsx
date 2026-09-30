import type { ReactNode } from 'react'

export default function Card({ title, children }: { title: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-panel p-4">
      <h2 className="mb-3 font-semibold">{title}</h2>
      {children}
    </section>
  )
}
