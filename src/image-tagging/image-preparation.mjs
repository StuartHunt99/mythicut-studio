import sharp from 'sharp';

export const IMAGE_PRESETS = Object.freeze({
  economy: Object.freeze({ name: 'economy', maxEdge: 1024, jpegQuality: 80, detail: 'low' }),
  balanced: Object.freeze({ name: 'balanced', maxEdge: 1536, jpegQuality: 85, detail: 'high' }),
  detail: Object.freeze({ name: 'detail', maxEdge: 2048, jpegQuality: 88, detail: 'high' })
});

const MEDIA_TYPES = new Map([
  ['jpeg', 'image/jpeg'], ['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'],
  ['gif', 'image/gif'], ['tiff', 'image/tiff'], ['heif', 'image/heif'], ['avif', 'image/avif']
]);

function source(path) {
  if (typeof path !== 'string' || !path) throw new Error('An image path is required');
  return sharp(path, { animated: false, page: 0, failOn: 'error' });
}

export async function inspectImage(path) {
  try {
    const metadata = await source(path).metadata();
    if (!metadata.width || !metadata.height || !metadata.format) throw new Error('Image dimensions or format are unavailable');
    return {
      readable: true,
      mediaType: MEDIA_TYPES.get(metadata.format) ?? `image/${metadata.format}`,
      width: metadata.width,
      height: metadata.height,
      orientation: metadata.orientation ?? null,
      hasAlpha: Boolean(metadata.hasAlpha)
    };
  } catch (error) {
    return { readable: false, error: String(error.message || error).slice(0, 1000) };
  }
}

export async function prepareImageForApi(path, { preset = 'economy' } = {}) {
  const settings = IMAGE_PRESETS[preset];
  if (!settings) throw new Error('Unknown image preset');
  const metadata = await source(path).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Image dimensions are unavailable');
  let pipeline = source(path).rotate().resize({ width: settings.maxEdge, height: settings.maxEdge, fit: 'inside', withoutEnlargement: true });
  const keepAlpha = Boolean(metadata.hasAlpha);
  pipeline = keepAlpha ? pipeline.png({ compressionLevel: 9, adaptiveFiltering: true }) : pipeline.jpeg({ quality: settings.jpegQuality, mozjpeg: true });
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  if (!info.width || !info.height || info.width > settings.maxEdge || info.height > settings.maxEdge) throw new Error('Prepared image violates the selected dimension limit');
  const mediaType = keepAlpha ? 'image/png' : 'image/jpeg';
  if (!data.length) throw new Error('Prepared image is empty');
  return {
    bytes: data,
    mediaType,
    width: info.width,
    height: info.height,
    encodedBytes: data.length,
    preset: settings.name,
    detail: settings.detail,
    transformVersion: 1
  };
}
