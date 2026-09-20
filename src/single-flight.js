export function createSingleFlight() {
  let inFlight = null;
  return (operation) => {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(operation).finally(() => { inFlight = null; });
    return inFlight;
  };
}
