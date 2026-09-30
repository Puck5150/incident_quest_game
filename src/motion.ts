// True when motion should be skipped: the OS asks for reduced motion, or the
// player turned on "Reduce motion" in the app (which sets html.reduce-motion).
export const motionReduced = () =>
  document.documentElement.classList.contains('reduce-motion') ||
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
