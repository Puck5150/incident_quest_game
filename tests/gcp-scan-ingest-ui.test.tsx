// @vitest-environment jsdom
// gcp-scan-ingest-major, perimeter stage, played through IncidentScreen: the typed apply counts only while
// ingress.yaml on disk is the merged narrow rule at that moment.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Session } from '../src/game/engine.ts'

beforeEach(() => localStorage.clear())
afterEach(cleanup)

const press = (cmd: string) => {
  const input = screen.getByLabelText('Terminal command')
  fireEvent.change(input, { target: { value: cmd } })
  fireEvent.keyDown(input, { key: 'Enter' })
}
const idle = () => waitFor(() => expect(screen.getByRole('log', { name: 'Terminal output' }).getAttribute('aria-busy')).toBe('false'))
const type = async (cmd: string) => {
  await idle()
  press(cmd)
  await idle()
}
const output = () => screen.getByRole('log', { name: 'Terminal output' }).textContent
const APPLY = 'gcloud access-context-manager perimeters update pr_datalake --policy=518273645190 --set-ingress-policies=ingress.yaml'

describe('gcp-scan-ingest-major perimeter stage', () => {
  it('does not count the apply for a broad file, counts it for the merged narrow file', async () => {
    const { default: IncidentScreen } = await import('../src/screens/IncidentScreen.tsx')
    const item = await (await import('virtual:content')).loadItem('gcp-scan-ingest-major')
    if (item.kind !== 'incident') throw new Error('expected an incident')
    const box: { saved?: Session } = {}
    render(<IncidentScreen scenario={item.scenario} onResolved={() => {}} onChange={(s) => (box.saved = s)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept mission' }))
    const taken = () => box.saved!.log.flatMap((e) => (e.type === 'TAKE_ACTION' ? [e.id] : []))
    const declare = (text: RegExp) => {
      fireEvent.click(screen.getByLabelText(text))
      fireEvent.click(screen.getByRole('button', { name: 'Declare hypothesis' }))
    }
    // Stage 1
    declare(/no roles\/iam\.workloadIdentityUser binding/)
    await type('gcloud iam service-accounts add-iam-policy-binding scan-ingest@apps-prod.iam.gserviceaccount.com --role roles/iam.workloadIdentityUser --member "serviceAccount:apps-prod.svc.id.goog[scans/scan-ingest]"')
    await waitFor(() => expect(taken()).toEqual(['bind-wi']))
    fireEvent.click(screen.getByRole('button', { name: 'Close out' }))
    // Stage 2
    declare(/enforced the pr_datalake perimeter/)
    await type(APPLY)
    expect(output()).toMatch(/does not count it as the fix/)
    expect(taken()).not.toContain('ingress-rule')
    fireEvent.click(screen.getByRole('button', { name: /Edit ingress\.yaml into the perimeter/ }))
    await waitFor(() => expect(taken()).toContain('ingress-file'))
    await type(APPLY)
    await waitFor(() => expect(taken()).toContain('ingress-rule'))
    // Broadening the file again and re-applying cannot un-take it, but a broad apply before narrowing never counted.
    await type(`echo '- x' > ingress.yaml`)
    await type(APPLY)
    expect(output()).toMatch(/does not count it as the fix/)
  })
})
