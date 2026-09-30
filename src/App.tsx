import content from 'virtual:content'
import IncidentScreen from './screens/IncidentScreen.tsx'

// Milestone 2: one hardcoded scenario. The incident queue arrives in Milestone 4.
const scenario = content.scenarios.find((s) => s.id === 'full-disk')!

export default function App() {
  return <IncidentScreen scenario={scenario} />
}
