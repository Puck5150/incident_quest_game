// "Ship dark": content with `published: false` is validated and tested but not
// offered to players. Preview mode shows it anyway (marked) so authors can try
// it on the live site. On in dev, and with ?preview=1 (remembered for the
// session so navigation keeps it).

const KEY = 'incident-quest:preview'

export function previewOn(): boolean {
  if (import.meta.env.DEV) return true
  let fromUrl = false
  try {
    fromUrl = new URLSearchParams(location.search).get('preview') === '1'
  } catch {
    // no location: not a browser
  }
  try {
    if (fromUrl) sessionStorage.setItem(KEY, '1')
    return fromUrl || sessionStorage.getItem(KEY) === '1'
  } catch {
    return fromUrl // storage blocked: the flag still works for this page load
  }
}

// THE one filter: every list a player sees (board, counts, map, unlocks,
// shifts) is built from items that pass this.
export const visible = <T extends { published: boolean }>(items: T[], preview: boolean): T[] =>
  preview ? items : items.filter((x) => x.published)
