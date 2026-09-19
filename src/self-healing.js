export function shouldRunMaintenance({ now, lastRunAt = 0, intervalMs }) {
  return Number.isFinite(intervalMs) && intervalMs > 0 && now - lastRunAt >= intervalMs;
}

export function shouldRecoverGateway({ isReady, now, unavailableSince = 0, lastRecoveryAt = 0, graceMs, cooldownMs }) {
  if (isReady) return false;
  if (!unavailableSince) return false;
  return now - unavailableSince >= graceMs && now - lastRecoveryAt >= cooldownMs;
}

export async function retryRecoverable(operation, {
  attempts = 2,
  delayMs = 750,
  jitterRatio = 0.2,
  isRecoverable = () => true,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRecoverable(error)) throw error;
      const jitter = Math.max(0, Math.min(1, jitterRatio)) * Math.random() * delayMs;
      await sleep(Math.round(delayMs * attempt + jitter));
    }
  }
  throw lastError;
}
