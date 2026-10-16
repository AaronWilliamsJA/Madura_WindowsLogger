// Runs before first paint so a saved theme never flashes the wrong colours.
try {
  const saved = localStorage.getItem('madura-logger-theme');
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
} catch {
  // storage unavailable: follow the system theme
}
