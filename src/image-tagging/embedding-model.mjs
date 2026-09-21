import { mkdir } from 'node:fs/promises';

export const BGE_SMALL_PROFILE = Object.freeze({
  name: 'BGE Small English v1.5',
  runtime: 'transformers-js-onnx',
  model: 'onnx-community/bge-small-en-v1.5-ONNX',
  modelRevision: '4a9a46c7b88fa408e650a571a1800243f26309bd',
  modelDtype: 'q8',
  dimension: 384,
  pooling: 'cls',
  normalized: true,
  queryPrefix: 'Represent this sentence for searching relevant passages: '
});

function splitTensor(tensor, expectedCount, dimension) {
  if (!tensor?.data || !ArrayBuffer.isView(tensor.data)) throw new Error('Embedding model returned invalid tensor data');
  if (tensor.data.length !== expectedCount * dimension) throw new Error(`Embedding model returned ${tensor.data.length} values; expected ${expectedCount * dimension}`);
  return Array.from({ length: expectedCount }, (_, index) => Float32Array.from(tensor.data.subarray(index * dimension, (index + 1) * dimension)));
}

export async function createBgeSmallEmbeddingModel({ cacheDirectory, allowDownload = true, progress = () => {}, pipelineFactory } = {}) {
  if (cacheDirectory) await mkdir(cacheDirectory, { recursive: true });
  let pipeline = pipelineFactory;
  if (!pipeline) {
    const transformers = await import('@huggingface/transformers');
    if (cacheDirectory) transformers.env.cacheDir = cacheDirectory;
    transformers.env.allowLocalModels = true;
    transformers.env.allowRemoteModels = Boolean(allowDownload);
    pipeline = transformers.pipeline;
  }
  const extractor = await pipeline('feature-extraction', BGE_SMALL_PROFILE.model, {
    revision: BGE_SMALL_PROFILE.modelRevision,
    dtype: BGE_SMALL_PROFILE.modelDtype,
    progress_callback: value => progress(value)
  });
  const embed = async values => {
    const texts = Array.isArray(values) ? values : [values];
    if (!texts.length) return [];
    const tensor = await extractor(texts, { pooling: BGE_SMALL_PROFILE.pooling, normalize: true });
    return splitTensor(tensor, texts.length, BGE_SMALL_PROFILE.dimension);
  };
  return Object.freeze({
    profile: BGE_SMALL_PROFILE,
    embedDocuments: texts => embed(texts),
    async embedQuery(text) { return (await embed(`${BGE_SMALL_PROFILE.queryPrefix}${String(text).trim()}`))[0]; },
    async close() { if (typeof extractor.dispose === 'function') await extractor.dispose(); }
  });
}
