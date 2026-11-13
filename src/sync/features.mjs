import FFT from 'fft.js';

export const ANALYSIS_RATE = 8000;
const FFT_SIZE = 256;
const HOP = 80;
const BANDS = 10;
const EPSILON = 1e-12;
const searchers = new WeakMap();

// Log band energy preserves speech patterns while tolerating microphone gain,
// polarity and tone differences. No transcript or language model is involved.
export function spectralFeatures(samples) {
  const count = Math.max(0, Math.floor((samples.length - FFT_SIZE) / HOP) + 1);
  const bands = Array.from({ length: BANDS }, () => new Float32Array(count));
  const fft = new FFT(FFT_SIZE), input = new Float64Array(FFT_SIZE), output = fft.createComplexArray();
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT_SIZE - 1)));
  const edges = Array.from({ length: BANDS + 1 }, (_, i) => Math.round(3 * (119 / 3) ** (i / BANDS)));
  for (let frame = 0; frame < count; frame++) {
    for (let i = 0; i < FFT_SIZE; i++) input[i] = samples[frame * HOP + i] * window[i];
    fft.realTransform(output, input);
    for (let band = 0; band < BANDS; band++) {
      let energy = 0;
      for (let bin = edges[band]; bin < edges[band + 1]; bin++) energy += output[2 * bin] ** 2 + output[2 * bin + 1] ** 2;
      bands[band][frame] = Math.log(Math.max(energy / (edges[band + 1] - edges[band]), EPSILON));
    }
  }
  return { bands, count, step: HOP / ANALYSIS_RATE };
}

// One target's FFTs are reused for every query window of the same length.
export function featureSearcher(target) {
  if (searchers.has(target)) return searchers.get(target);
  const transforms = new Map();
  const search = (query, start, count, { from = 0, to = target.count - count } = {}) => {
    if (count < 10 || to < from || count > target.count) return null;
    const size = 2 ** Math.ceil(Math.log2(target.count + count - 1));
    let cached = transforms.get(size);
    if (!cached) {
      const fft = new FFT(size);
      const spectra = target.bands.map(band => {
        const input = new Float64Array(size); input.set(band);
        const spectrum = new Float64Array(size * 2); fft.realTransform(spectrum, input); fft.completeSpectrum(spectrum);
        const sums = new Float64Array(band.length + 1), squares = new Float64Array(band.length + 1);
        for (let i = 0; i < band.length; i++) { sums[i + 1] = sums[i] + band[i]; squares[i + 1] = squares[i] + band[i] ** 2; }
        return { spectrum, sums, squares };
      });
      // Queries run serially in the worker. Reuse scratch buffers instead of
      // allocating hundreds of large arrays for a long recorder file.
      cached = { fft, spectra, input: new Float64Array(size), spectrum: new Float64Array(size * 2),
        product: new Float64Array(size * 2), correlation: new Float64Array(size * 2) };
      transforms.set(size, cached);
    }
    const { fft, spectra, input, spectrum, product, correlation } = cached;
    const low = Math.max(0, Math.floor(from)), high = Math.min(target.count - count, Math.ceil(to));
    const scores = new Float64Array(high - low + 1);
    for (let band = 0; band < query.bands.length; band++) {
      const values = query.bands[band].subarray(start, start + count);
      const mean = values.reduce((a, b) => a + b, 0) / count;
      input.fill(0);
      let variance = 0;
      for (let i = 0; i < count; i++) { input[i] = values[i] - mean; variance += input[i] ** 2; }
      if (variance < EPSILON) continue;
      fft.realTransform(spectrum, input); fft.completeSpectrum(spectrum);
      const targetBand = spectra[band];
      for (let i = 0; i < product.length; i += 2) {
        const ar = targetBand.spectrum[i], ai = targetBand.spectrum[i + 1], br = spectrum[i], bi = spectrum[i + 1];
        product[i] = ar * br + ai * bi; product[i + 1] = ai * br - ar * bi;
      }
      fft.inverseTransform(correlation, product);
      for (let i = low; i <= high; i++) {
        const sum = targetBand.sums[i + count] - targetBand.sums[i];
        const power = targetBand.squares[i + count] - targetBand.squares[i] - sum * sum / count;
        scores[i - low] += correlation[2 * i] / Math.sqrt(Math.max(variance * power, EPSILON)) / query.bands.length;
      }
    }
    let best = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
    let second = -1;
    const exclusion = Math.ceil(1 / target.step);
    for (let i = 0; i < scores.length; i++) if (Math.abs(i - best) > exclusion) second = Math.max(second, scores[i]);
    return { frame: best + low, correlation: scores[best], margin: scores[best] - second };
  };
  searchers.set(target, search);
  return search;
}

export function matchFeatures(a, b) {
  if (Math.min(a.count, b.count) * a.step < 2) return null;
  // Search windows of the shorter recording; this also works when only part
  // of that recording overlaps the other one.
  const swapped = a.count > b.count;
  const query = swapped ? b : a, target = swapped ? a : b;
  const search = featureSearcher(target);
  const count = Math.min(Math.round(8 / query.step), Math.floor(query.count / 4));
  const starts = new Set(Array.from({ length: 7 }, (_, i) => Math.round((query.count - count) * i / 6)));
  const anchors = [];
  const measure = start => {
    const found = search(query, start, count);
    if (!found || found.correlation < 0.58 || found.margin < 0.07) return;
    const tQuery = start * query.step, tTarget = found.frame * target.step;
    anchors.push({ a: swapped ? tTarget : tQuery, b: swapped ? tQuery : tTarget,
      correlation: found.correlation, margin: found.margin });
  };
  for (const start of starts) measure(start);
  // Difficult partial overlaps get a denser retry, rather than an assumed gap.
  if (anchors.length < 2) {
    for (let start = 0; start <= query.count - count; start += Math.max(1, Math.floor(count / 2))) {
      if (!starts.has(start)) measure(start);
    }
  }
  if (anchors.length < 2) return null;
  // RANSAC over plausible recorder clocks rejects isolated repeated-speech peaks.
  let best = [];
  for (let i = 0; i < anchors.length; i++) for (let j = i + 1; j < anchors.length; j++) {
    const first = anchors[i], last = anchors[j];
    if (Math.abs(last.a - first.a) < Math.max(0.5, (count - 1) * query.step / 2)) continue;
    const rate = (last.b - first.b) / (last.a - first.a);
    if (Math.abs(rate - 1) > 0.002) continue;
    const offset = first.b - rate * first.a;
    const inliers = anchors.filter(p => Math.abs(p.b - (offset + rate * p.a)) <= 0.025);
    if (inliers.length > best.length) best = inliers;
  }
  if (best.length < 2 || best.length < anchors.length * 0.6) return null;
  const meanA = best.reduce((sum, p) => sum + p.a, 0) / best.length;
  const meanB = best.reduce((sum, p) => sum + p.b, 0) / best.length;
  const variance = best.reduce((sum, p) => sum + (p.a - meanA) ** 2, 0);
  const rate = best.reduce((sum, p) => sum + (p.a - meanA) * (p.b - meanB), 0) / variance;
  const intercept = meanB - rate * meanA;
  const span = Math.max(...best.map(p => p.a)) - Math.min(...best.map(p => p.a));
  const driftSeconds = Math.abs(rate - 1) * span;
  const offsets = best.map(p => p.a - p.b).sort((x, y) => x - y);
  const medianOffset = (offsets[Math.floor((offsets.length - 1) / 2)] + offsets[Math.floor(offsets.length / 2)]) / 2;
  // Do not extrapolate a noisy, insignificant slope back to the file origin.
  return { offset: driftSeconds > 0.02 ? -intercept : medianOffset,
    confidence: best.reduce((sum, p) => sum + p.correlation, 0) / best.length,
    driftPpm: (rate - 1) * 1e6, driftSeconds, anchors: best };
}
