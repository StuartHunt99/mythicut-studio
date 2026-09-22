import { compileOutputSchema, validateSchemaDefinition } from './schema.mjs';
import { renderPrompt } from '../prompt-templates.mjs';

export function compileTaggingRequest({ definition, filename, relativePath, extraInstructions = '', promptTemplate = null }) {
  const schema = validateSchemaDefinition(definition);
  if (typeof filename !== 'string' || !filename || filename.length > 1024) throw new Error('A valid filename is required');
  if (typeof relativePath !== 'string' || relativePath.length > 4096) throw new Error('A valid relative path is required');
  if (typeof extraInstructions !== 'string' || extraInstructions.length > 8000) throw new Error('Extra instructions are too long');
  const fields = schema.fields.map(field => {
    const options = field.type === 'free_text' ? '' : ` Allowed values: ${field.options.filter(option => !option.archived).map(option => `${option.key} (${option.label})`).join(', ')}.`;
    return `- ${field.key} (${field.type}): ${field.label}.${options}`;
  }).join('\n');
  const rendered = renderPrompt('imageTagging', { fields, filename, relativePath,
    extraInstructions: extraInstructions.trim() ? `\nAdditional tagging guidance: ${extraInstructions.trim()}` : '' }, promptTemplate);
  return { systemText: rendered.systemText, userText: rendered.userText, outputSchema: compileOutputSchema(schema), promptTemplate: rendered.template };
}
