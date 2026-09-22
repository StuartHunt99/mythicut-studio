import { pathToFileURL } from 'node:url';

// Premiere's FCP7 XML importer expects a local Windows drive as a localhost URL.
// Keep filesystem paths separate from this interchange-only representation.
export function fcpPathUrl(path) {
  const href = pathToFileURL(path).href;
  return href.replace(/^file:\/\/\/([A-Za-z]):\//, (_, drive) => `file://localhost/${drive}%3A/`);
}
