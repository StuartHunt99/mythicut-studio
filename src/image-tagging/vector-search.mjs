export function encodeFloat32LE(vector) {
  const values = vector instanceof Float32Array ? vector : Float32Array.from(vector);
  const buffer = Buffer.allocUnsafe(values.length * 4);
  for (let index = 0; index < values.length; index++) buffer.writeFloatLE(values[index], index * 4);
  return buffer;
}

export function decodeFloat32LE(buffer, expectedDimension) {
  if (!Buffer.isBuffer(buffer) && !(buffer instanceof Uint8Array)) throw new Error('Embedding vector must be binary data');
  if (buffer.byteLength % 4 !== 0) throw new Error('Embedding vector has an invalid byte length');
  const values = new Float32Array(buffer.byteLength / 4);
  const source = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  for (let index = 0; index < values.length; index++) values[index] = source.readFloatLE(index * 4);
  if (expectedDimension != null && values.length !== expectedDimension) throw new Error(`Embedding vector dimension ${values.length} does not match profile dimension ${expectedDimension}`);
  return values;
}

export function cosineForNormalizedVectors(left, right) {
  if (left.length !== right.length) throw new Error('Cannot compare embeddings with different dimensions');
  let score = 0;
  for (let index = 0; index < left.length; index++) score += left[index] * right[index];
  return score;
}
