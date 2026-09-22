const { existsSync } = require('node:fs');
const path = require('node:path');

const toolDirectories = [
  path.resolve(__dirname, '../.local/tools/ffmpeg/bin'),
  path.resolve(__dirname, '../.local/tools/whisper')
];

function prepareLocalTools() {
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const present = toolDirectories.filter(directory => existsSync(directory) &&
    !current.some(item => path.resolve(item).toLowerCase() === directory.toLowerCase()));
  if (present.length) process.env.PATH = [...present, ...current].join(path.delimiter);
  return toolDirectories.filter(existsSync);
}

module.exports = { prepareLocalTools };
