function normalize(value) {
  return String(value || '不明なエラー').replace(/\s+/g, ' ').replace(/\b\d{6,}\b/g, '#').trim().slice(0, 500);
}

export function errorFingerprint(scope, error) {
  return `${normalize(scope)}|${normalize(error?.code || error?.name)}|${normalize(error?.message || error)}`;
}

export function createErrorDeduper({ windowMs = 30 * 60_000, now = () => Date.now() } = {}) {
  const recent = new Map();
  return {
    shouldNotify(scope, error) {
      const fingerprint = errorFingerprint(scope, error);
      const timestamp = now();
      const previous = recent.get(fingerprint);
      if (previous && timestamp - previous.lastAt < windowMs) {
        previous.lastAt = timestamp;
        previous.suppressed += 1;
        return { notify: false, fingerprint, suppressed: previous.suppressed };
      }
      recent.set(fingerprint, { lastAt: timestamp, suppressed: 0 });
      return { notify: true, fingerprint, suppressed: previous?.suppressed || 0 };
    },
  };
}
