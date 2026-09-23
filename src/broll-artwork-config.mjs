export const DEFAULT_ARTWORK_CONFIG = Object.freeze({ minimumClipSeconds: 4 });

export function validateArtworkConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !Object.hasOwn(DEFAULT_ARTWORK_CONFIG, key))) {
    throw new Error('Invalid B-roll artwork configuration');
  }
  const config = { ...DEFAULT_ARTWORK_CONFIG, ...input };
  if (!Number.isFinite(config.minimumClipSeconds) || config.minimumClipSeconds < 3 || config.minimumClipSeconds > 15) {
    throw new Error('Artwork minimum must be between 3 and 15 seconds');
  }
  return config;
}

// Beat plans saved before this setting existed used the five-second rule.
export function artworkMinimumForPlan(beatPlan) {
  const value = beatPlan?.artworkMinimumSeconds ?? 5;
  if (!Number.isFinite(value) || value < 3 || value > 15) throw new Error('Invalid saved artwork minimum');
  return value;
}
