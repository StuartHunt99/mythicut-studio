export function brollPreviewLayout(geometry) {
  if (!geometry) return null;
  const keyframeCrop = geometry.kind === 'zoom_in' ? geometry.endCrop : geometry.startCrop;
  const crop = keyframeCrop && Number.isFinite(keyframeCrop.relativeScale) && keyframeCrop.relativeScale > 0
    ? { width: keyframeCrop.width * keyframeCrop.relativeScale,
      height: keyframeCrop.height * keyframeCrop.relativeScale } : null;
  if (crop) { crop.x = (1 - crop.width) / 2; crop.y = (1 - crop.height) / 2; }
  if (!crop || ![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite) ||
      crop.width <= 0 || crop.height <= 0 || crop.x < -1e-9 || crop.y < -1e-9 ||
      crop.x + crop.width > 1 + 1e-9 || crop.y + crop.height > 1 + 1e-9) {
    throw new Error('Invalid stored crop for B-roll preview');
  }
  return { widthPercent: 100 / crop.width, heightPercent: 100 / crop.height,
    leftPercent: -100 * crop.x / crop.width, topPercent: -100 * crop.y / crop.height,
    crop, keyframe: 'full' };
}
