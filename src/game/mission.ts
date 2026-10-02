// A stable, ops-style reference for each mission (display only, so a rare
// collision is harmless). Same id, same number, every visit.
export const missionId = (id: string, kind: 'incident' | 'challenge') =>
  `${kind === 'challenge' ? 'BLD' : 'INC'}-${String([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 10000, 7)).padStart(4, '0')}`
