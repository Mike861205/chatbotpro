(function attachAuthRequest(global) {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const transientStatuses = new Set([502, 503, 504]);

  async function fetchWhenReady(input, init = {}, options = {}) {
    const attempts = Math.max(1, Number(options.attempts) || 30);
    const baseDelayMs = Number.isFinite(options.baseDelayMs) ? Math.max(0, options.baseDelayMs) : 250;
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(input, { ...init, cache: 'no-store' });
        if (!transientStatuses.has(response.status) || attempt === attempts) return response;
        lastError = new Error(`Servidor temporalmente no disponible (${response.status})`);
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
      }

      const delay = Math.min(1000, baseDelayMs * attempt);
      if (delay) await sleep(delay);
    }

    const unavailable = new Error('El servidor local todavía está iniciando. Espera un momento y vuelve a intentar.');
    unavailable.cause = lastError;
    throw unavailable;
  }

  global.CBPAuthRequest = { fetch: fetchWhenReady };
})(window);
