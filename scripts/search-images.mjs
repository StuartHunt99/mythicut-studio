import { resolve } from 'node:path';
import { openImageCatalog } from '../src/image-tagging/catalog.mjs';

function argumentsByName(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`Missing value for --${name}`);
    values[name] = value;
  }
  return values;
}

const list = value => value ? value.split(',').map(item => item.trim()).filter(Boolean) : [];
const options = argumentsByName(process.argv.slice(2));
if (!options.catalog || !options.query) {
  console.error('Usage: npm run search:images -- --catalog <catalog.sqlite> --query <text> --book <key[,key]> [--character <key[,key]>] [--setting <key[,key]>] [--mood <key[,key]>] [--image-type <key[,key]>] [--limit 5] [--model-cache <directory>]');
  process.exitCode = 2;
} else {
  const catalog = await openImageCatalog({
    databasePath: resolve(options.catalog),
    modelCachePath: resolve(options['model-cache'] ?? 'artifacts/electron-data/embedding-models')
  });
  try {
    const result = await catalog.execute('search.hybrid', {
      semanticText: options.query,
      bookKeys: list(options.book),
      centralCharacterKeys: list(options.character),
      settingKeys: list(options.setting),
      moodKeys: list(options.mood),
      imageTypeKeys: list(options['image-type']),
      limit: options.limit == null ? 5 : Number(options.limit)
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    catalog.close();
  }
}
