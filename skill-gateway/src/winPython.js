/**
 * Windows: use pythonw.exe for background scripts so no console window flashes.
 * Override with FRIDAY_PYTHON_CHILD (full path or command name).
 */
export function pythonChildExecutable() {
  const override = process.env.FRIDAY_PYTHON_CHILD?.trim();
  if (override) return override;
  return process.platform === 'win32' ? 'pythonw' : 'python3';
}
