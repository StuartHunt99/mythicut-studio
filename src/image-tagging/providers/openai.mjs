import OpenAI from 'openai';

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png']);
const ALLOWED_DETAILS = new Set(['low', 'high', 'auto']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function validateEndpoint(endpoint, { allowCustomEndpoint }) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('Provider endpoint must use HTTPS');
  if (!allowCustomEndpoint && url.origin !== 'https://api.openai.com') throw new Error('The OpenAI provider must use api.openai.com');
  return url.toString().replace(/\/$/, '');
}

function validatePreparedImage(image) {
  if (!image || !Buffer.isBuffer(image.bytes) || image.bytes.length < 1) throw new Error('A prepared image buffer is required');
  if (image.bytes.length > MAX_IMAGE_BYTES) throw new Error('Prepared image exceeds the 20 MB safety limit');
  if (!ALLOWED_MEDIA_TYPES.has(image.mediaType)) throw new Error('Prepared image must be JPEG or PNG');
  if (!Number.isInteger(image.width) || !Number.isInteger(image.height) || image.width < 1 || image.height < 1 || image.width > 2048 || image.height > 2048) {
    throw new Error('Prepared image dimensions must be between 1 and 2048 pixels');
  }
  if (!ALLOWED_DETAILS.has(image.detail)) throw new Error('Prepared image has an unsupported detail level');
}

function extractRefusal(response) {
  for (const item of response?.output ?? []) {
    for (const content of item?.content ?? []) {
      if (content?.type === 'refusal' && content.refusal) return content.refusal;
    }
  }
  return null;
}

export function createOpenAIProvider({
  apiKey,
  endpoint = 'https://api.openai.com/v1',
  timeoutMs = 60_000,
  allowCustomEndpoint = false,
  client
} = {}) {
  if (!client && (typeof apiKey !== 'string' || !apiKey.trim())) throw new Error('An API key is required');
  const baseURL = validateEndpoint(endpoint, { allowCustomEndpoint });
  const api = client ?? new OpenAI({ apiKey: apiKey.trim(), baseURL, timeout: timeoutMs, maxRetries: 0 });

  return Object.freeze({
    async generate({ model, image, systemText, userText, outputSchema, signal }) {
      if (typeof model !== 'string' || !model.trim()) throw new Error('A provider model is required');
      validatePreparedImage(image);
      const response = await api.responses.create({
        model: model.trim(),
        instructions: systemText,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: userText },
            { type: 'input_image', detail: image.detail, image_url: `data:${image.mediaType};base64,${image.bytes.toString('base64')}` }
          ]
        }],
        text: {
          format: {
            type: 'json_schema',
            name: 'image_tags',
            description: 'Tags for one catalog image using the active published schema.',
            strict: true,
            schema: outputSchema
          }
        },
        max_output_tokens: 1_200,
        store: false
      }, { signal, timeout: timeoutMs });

      const refusal = extractRefusal(response);
      if (refusal) throw new Error(`The model refused the image: ${refusal}`);
      if (!response.output_text) throw new Error('The provider returned no tag output');
      let values;
      try { values = JSON.parse(response.output_text); }
      catch (error) { throw new Error(`The provider returned invalid JSON: ${error.message}`); }
      return {
        values,
        providerRequestId: response.id ?? null,
        providerModel: response.model ?? model,
        usage: response.usage ?? null
      };
    }
  });
}

export function createOpenAICompatibleProvider(options = {}) {
  return createOpenAIProvider({ ...options, allowCustomEndpoint: true });
}
