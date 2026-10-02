// Opt-in sound cues, synthesized with Web Audio so there are no files to load.
// App flips `enabled` from the player's setting; everything else just calls play().
let enabled = false
let ctx: AudioContext | undefined

export const setSound = (on: boolean) => {
  enabled = on
}

// Each cue is a few short sine notes: [frequency Hz, start s, length s].
const CUES = {
  accept: [[880, 0, 0.09], [880, 0.14, 0.09], [1320, 0.28, 0.16]], // pager chirp
  clear: [[523, 0, 0.12], [659, 0.1, 0.12], [784, 0.2, 0.25]], // rising all-clear
} satisfies Record<string, [number, number, number][]>

export function play(cue: keyof typeof CUES) {
  if (!enabled || typeof AudioContext === 'undefined') return
  ctx ??= new AudioContext()
  const t0 = ctx.currentTime
  for (const [f, start, len] of CUES[cue]) {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.frequency.value = f
    gain.gain.setValueAtTime(0.08, t0 + start)
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + start + len)
    osc.connect(gain).connect(ctx.destination)
    osc.start(t0 + start)
    osc.stop(t0 + start + len)
  }
}
