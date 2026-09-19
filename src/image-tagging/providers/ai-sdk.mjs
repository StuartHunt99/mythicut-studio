import { generateText, jsonSchema, Output } from 'ai';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const ALLOWED_MEDIA_TYPES = new Set(['image/jpeg', 'image/png']);
const ALLOWED_DETAILS = new Set(['low', 'high', 'auto']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const PROVIDER_DEFAULTS = Object.freeze({
  openai: Object.freeze({ name: 'OpenAI', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }),
  google: Object.freeze({ name: 'Google Gemini', endpoint: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-3.6-flash' }),
  'openai-compatible': Object.freeze({ name: 'OpenAI-compatible', endpoint: 'https://api.openai.com/v1', model: '' })
});

export const SUPPORTED_PROVIDER_DIALECTS = Object.freeze(Object.keys(PROVIDER_DEFAULTS));

function validateEndpoint(dialect, endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('Provider endpoint must use HTTPS');
  if (dialect === 'openai' && url.origin !== 'https://api.openai.com') throw new Error('The OpenAI provider must use api.openai.com');
  if (dialect === 'google' && url.origin !== 'https://generativelanguage.googleapis.com') throw new Error('The Google provider must use generativelanguage.googleapis.com');
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

function createModelFactory({ dialect, apiKey, endpoint, fetch }) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('An API key is required');
  const credential = apiKey.trim();
  if (dialect === 'openai') {
    const provider = createOpenAI({ apiKey: credential, baseURL: endpoint, fetch });
    return model => provider(model);
  }
  if (dialect === 'google') {
    const provider = createGoogle({ apiKey: credential, baseURL: endpoint, fetch });
    return model => provider(model);
  }
  const provider = createOpenAICompatible({
    name: 'configured-provider',
    apiKey: credential,
    baseURL: endpoint,
    fetch,
    supportsStructuredOutputs: false
  });
  return model => provider(model);
}

function providerOptions(dialect) {
  if (dialect === 'openai') return { openai: { store: false } };
  if (dialect === 'google') return { google: { structuredOutputs: false } };
  return undefined;
}

function serializeError(error) {
  if (!error || typeof error !== 'object') return { message: String(error) };
  const serialized = { name: error.name ?? 'Error', message: error.message ?? String(error) };
  for (const key of ['status', 'statusText', 'code', 'cause']) {
    if (error[key] !== undefined) serialized[key] = error[key];
  }
  if (error.response !== undefined) serialized.response = error.response;
  if (error.body !== undefined) {
    serialized.body = error.body;
    const nested = error.body?.error ?? error.body;
    if (nested && typeof nested === 'object') {
      if (nested.message && !serialized.message) serialized.message = String(nested.message);
      if (nested.code !== undefined) serialized.providerCode = nested.code;
      if (nested.status !== undefined) serialized.providerStatus = nested.status;
    }
  }
  return serialized;
}

export function createImageTagProvider({
  dialect,
  apiKey,
  endpoint,
  timeoutMs = 60_000,
  modelFactory,
  generate = generateText,
  fetch,
  logger
} = {}) {
  if (!SUPPORTED_PROVIDER_DIALECTS.includes(dialect)) throw new Error(`Unsupported provider type: ${dialect}`);
  const baseURL = validateEndpoint(dialect, endpoint ?? PROVIDER_DEFAULTS[dialect].endpoint);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 300_000) throw new Error('Provider timeout must be 5-300 seconds');
  const resolveModel = modelFactory ?? createModelFactory({ dialect, apiKey, endpoint: baseURL, fetch });
  const emit = typeof logger === 'function' ? logger : event => {
    const prefix = event.kind === 'request' ? '[AI request]' : event.kind === 'response' ? '[AI response]' : '[AI error]';
    console.error(prefix, JSON.stringify(event, null, 2));
  };

  return Object.freeze({
    async generateTags({ model, image, systemText, userText, outputSchema, signal }) {
      if (typeof model !== 'string' || !model.trim()) throw new Error('A provider model is required');
      if (typeof systemText !== 'string' || !systemText.trim()) throw new Error('Provider system instructions are required');
      if (typeof userText !== 'string' || !userText.trim()) throw new Error('Provider user instructions are required');
      if (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema)) throw new Error('A structured output schema is required');
      validatePreparedImage(image);

      const modelName = model.trim();
      const payload = {
        dialect,
        model: modelName,
        request: {
          systemText,
          userText,
          image: {
            bytes: image.bytes.length,
            mediaType: image.mediaType,
            width: image.width,
            height: image.height,
            detail: image.detail
          },
          outputSchema
        }
      };
      emit({ kind: 'request', ...payload });

      const options = providerOptions(dialect);
      try {
        const result = await generate({
          model: resolveModel(modelName),
          instructions: systemText,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: userText },
              {
                type: 'file',
                data: image.bytes,
                mediaType: image.mediaType,
                ...(dialect === 'openai' ? { providerOptions: { openai: { imageDetail: image.detail } } } : {})
              }
            ]
          }],
          output: Output.object({
            name: 'image_tags',
            description: 'Tags for one catalog image using the active published schema.',
            schema: jsonSchema(outputSchema)
          }),
          maxOutputTokens: 1_200,
          maxRetries: 0,
          timeout: timeoutMs,
          abortSignal: signal,
          ...(options ? { providerOptions: options } : {})
        });

        emit({
          kind: 'response',
          dialect,
          model: modelName,
          response: {
            requestId: result.response?.id ?? null,
            modelId: result.response?.modelId ?? modelName,
            finishReason: result.finishReason ?? null,
            usage: result.usage ?? null,
            output: result.output ?? null,
            text: result.text ?? null
          }
        });

        return {
          values: result.output,
          text: result.text ?? null,
          providerRequestId: result.response?.id ?? null,
          providerModel: result.response?.modelId ?? modelName,
          usage: result.usage ?? null,
          finishReason: result.finishReason ?? null
        };
      } catch (error) {
        const errorSummary = serializeError(error);
        const debug = { ...payload, error: errorSummary };
        emit({ kind: 'error', ...debug });
        throw Object.assign(error, {
          requestContext: {
            dialect,
            model: modelName,
            image: {
              bytes: image.bytes.length,
              mediaType: image.mediaType,
              width: image.width,
              height: image.height,
              detail: image.detail
            },
            error: errorSummary
          }
        });
      }
    }
  });
}
