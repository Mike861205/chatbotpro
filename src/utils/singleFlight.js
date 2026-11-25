// Share only work that is currently running. No completed result is cached.
function createSingleFlight() {
  const pending = new Map();
  return function singleFlight(key, loader) {
    if (pending.has(key)) return pending.get(key);
    const result = Promise.resolve().then(loader).finally(() => {
      if (pending.get(key) === result) pending.delete(key);
    });
    pending.set(key, result);
    return result;
  };
}

module.exports = { createSingleFlight };
