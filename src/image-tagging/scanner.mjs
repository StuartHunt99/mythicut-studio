import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectImage } from './image-preparation.mjs';

const SUPPORTED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.bmp', '.gif', '.avif', '.heic', '.heif']);

const posix = value => value.split(sep).join('/');

function globRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 500) throw new Error('Exclude patterns must be 1-500 characters');
  let result = '^';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') { result += '.*'; index++; }
    else if (char === '*') result += '[^/]*';
    else if (char === '?') result += '[^/]';
    else result += char.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${result}$`, 'i');
}

function excluded(relativePath, patterns) {
  return patterns.some(pattern => globRegex(pattern).test(relativePath));
}

async function enumerate(root, { signal, progress }) {
  const files = [];
  const patterns = JSON.parse(root.exclude_json);
  async function visit(directory) {
    if (signal?.aborted) throw new Error('Image scan canceled');
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }));
    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Image scan canceled');
      if (!root.include_hidden && entry.name.startsWith('.')) continue;
      if (entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      const relativePath = posix(relative(root.canonical_path, path));
      if (!relativePath || relativePath.startsWith('../') || excluded(relativePath, patterns)) continue;
      if (entry.isDirectory()) { if (root.recursive) await visit(path); continue; }
      if (!entry.isFile() || !SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      files.push({ path, relativePath });
      progress?.({ stage: 'scan.enumerate', rootId: root.id, visited: files.length, filename: relativePath });
    }
  }
  await visit(root.canonical_path);
  return files;
}

export async function scanRoot({ db, transaction }, rootId, { signal, progress = () => {}, clock = () => new Date(), id = randomUUID, inspect = inspectImage } = {}) {
  const root = db.prepare('SELECT * FROM roots WHERE id = ? AND enabled = 1').get(rootId);
  if (!root) throw new Error('Enabled root not found');
  const actualRoot = await realpath(root.canonical_path);
  if (actualRoot !== root.canonical_path) throw new Error('Root path identity changed; remove and add it again');
  const scanId = id();
  const files = await enumerate(root, { signal, progress });
  const summary = { rootId, scanId, visited: files.length, new: 0, changed: 0, unchanged: 0, unreadable: 0, missing: 0 };
  for (const [index, file] of files.entries()) {
    if (signal?.aborted) throw new Error('Image scan canceled');
    const canonicalPath = await realpath(file.path);
    if (!canonicalPath.startsWith(`${root.canonical_path}${sep}`)) continue;
    const identity = await stat(canonicalPath, { bigint: true });
    if (!identity.isFile()) continue;
    const now = clock().toISOString();
    let image = db.prepare('SELECT * FROM images WHERE catalog_id = ? AND canonical_path = ?').get(root.catalog_id, canonicalPath);
    let version = image?.current_version_id ? db.prepare('SELECT * FROM image_versions WHERE id = ?').get(image.current_version_id) : null;
    const sizeBytes = Number(identity.size); const mtimeNs = String(identity.mtimeNs);
    if (version && version.size_bytes === sizeBytes && version.mtime_ns === mtimeNs) {
      summary.unchanged++;
      transaction(() => {
        db.prepare('UPDATE images SET display_path = ?, filename = ?, last_seen_at = ?, availability = ? WHERE id = ?').run(canonicalPath, basename(canonicalPath), now, version.readable ? 'present' : 'unreadable', image.id);
        db.prepare(`INSERT INTO image_roots(image_id, root_id, relative_path, present, last_seen_scan) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(image_id, root_id) DO UPDATE SET relative_path = excluded.relative_path, present = 1, last_seen_scan = excluded.last_seen_scan`).run(image.id, root.id, file.relativePath, scanId);
      });
    } else {
      const details = await inspect(canonicalPath);
      const imageId = image?.id ?? id(); const versionId = id();
      transaction(() => {
        if (!image) {
          db.prepare('INSERT INTO images(id, catalog_id, canonical_path, display_path, filename, availability, current_version_id, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
            .run(imageId, root.catalog_id, canonicalPath, canonicalPath, basename(canonicalPath), details.readable ? 'present' : 'unreadable', now, now);
        }
        const previous = db.prepare('SELECT id FROM image_versions WHERE image_id = ? AND size_bytes = ? AND mtime_ns = ?').get(imageId, sizeBytes, mtimeNs);
        const observedVersionId = previous?.id ?? versionId;
        if (!previous) db.prepare('INSERT INTO image_versions(id, image_id, size_bytes, mtime_ns, media_type, width, height, orientation, readable, error_message, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(observedVersionId, imageId, sizeBytes, mtimeNs, details.mediaType ?? null, details.width ?? null, details.height ?? null, details.orientation ?? null, details.readable ? 1 : 0, details.error ?? null, now);
        db.prepare('UPDATE images SET display_path = ?, filename = ?, availability = ?, current_version_id = ?, last_seen_at = ? WHERE id = ?')
          .run(canonicalPath, basename(canonicalPath), details.readable ? 'present' : 'unreadable', observedVersionId, now, imageId);
        db.prepare(`INSERT INTO image_roots(image_id, root_id, relative_path, present, last_seen_scan) VALUES (?, ?, ?, 1, ?)
          ON CONFLICT(image_id, root_id) DO UPDATE SET relative_path = excluded.relative_path, present = 1, last_seen_scan = excluded.last_seen_scan`).run(imageId, root.id, file.relativePath, scanId);
      });
      if (!details.readable) summary.unreadable++;
      image ? summary.changed++ : summary.new++;
    }
    progress({ stage: 'scan.inspect', rootId: root.id, completed: index + 1, total: files.length, filename: file.relativePath });
  }
  if (signal?.aborted) throw new Error('Image scan canceled');
  transaction(() => {
    const missing = db.prepare('SELECT image_id FROM image_roots WHERE root_id = ? AND last_seen_scan <> ? AND present = 1').all(root.id, scanId);
    summary.missing = missing.length;
    db.prepare('UPDATE image_roots SET present = 0 WHERE root_id = ? AND last_seen_scan <> ?').run(root.id, scanId);
    db.prepare(`UPDATE images SET availability = 'missing'
      WHERE catalog_id = ? AND NOT EXISTS (SELECT 1 FROM image_roots membership WHERE membership.image_id = images.id AND membership.present = 1)`).run(root.catalog_id);
    db.prepare('UPDATE roots SET updated_at = ? WHERE id = ?').run(clock().toISOString(), root.id);
  });
  progress({ stage: 'scan.complete', ...summary });
  return summary;
}

export async function canonicalizeRoot(path) {
  const canonicalPath = await realpath(resolve(path));
  const details = await stat(canonicalPath);
  if (!details.isDirectory()) throw new Error('Selected root is not a directory');
  return canonicalPath;
}
