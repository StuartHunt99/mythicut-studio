import sharp from 'sharp';

// A small perceptual fingerprint is intentionally computed only for images
// that reached a beat's candidate list and were actually chosen. It is a
// warning signal, never a catalog-wide visual identity or a hard rejection.
export async function differenceHash(path) {
  const { data, info } = await sharp(path).rotate().resize(9, 8, { fit: 'fill' }).greyscale().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== 9 || info.height !== 8 || info.channels !== 1) throw new Error('Unable to fingerprint selected artwork');
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    bits = (bits << 1n) | BigInt(data[y * 9 + x] > data[y * 9 + x + 1] ? 1 : 0);
  }
  return bits.toString(16).padStart(16, '0');
}

export function hashDistance(first, second) {
  if (!/^[a-f0-9]{16}$/i.test(first) || !/^[a-f0-9]{16}$/i.test(second)) throw new Error('Invalid perceptual image hash');
  let difference = BigInt(`0x${first}`) ^ BigInt(`0x${second}`);
  let count = 0;
  while (difference) { difference &= difference - 1n; count++; }
  return count;
}
