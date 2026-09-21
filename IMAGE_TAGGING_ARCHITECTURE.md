# MythiCut Studio — configurable AI image tagging architecture and implementation plan

Status: proposed implementation plan  
Date: 2026-09-14  
Scope: a standalone image-catalog module inside MythiCut Studio, separate from the talking-head auto-edit workflow

## 1. Intended result

Create an image catalog from any number of user-selected folders, generate project-specific structured tags with an OpenAI API vision model by default, let a human review and revise those suggestions, and expose accepted tags to later b-roll selection through one stable query interface. Other hosted AI sources remain configurable through provider adapters; running models locally is not part of this plan.

The tagging module is a separate product slice, not another phase of the current auto-edit project. It gets its own window, preload interface, worker, persistence, schemas, jobs, and tests. The future production pipeline may open an image catalog and query it, but it must not know how scanning, prompting, provider calls, review, or embeddings work.

The first production target remains the current application stack:

- Node.js 24 and Electron 44, with domain code in ESM and Electron entry points in CommonJS.
- A sandboxed, context-isolated renderer with no direct filesystem, database, credential, or network access.
- A keyboard-first dark UI consistent with the current project screen.
- macOS first, without making file identities, paths, or provider behavior macOS-only. Windows packaging and path fixtures are required before calling the module cross-platform.

The module should serve the Chronicles of Narnia b-roll workflow without containing Narnia-specific fields, options, prompts, or retrieval logic.

## 2. Success measures

The initial proposal combines model latency and human review time in one “under three seconds per image” measure. Those are different systems and should be measured separately.

| Measure | Release interpretation |
| --- | --- |
| Tagging latency | Report median, p95, and images/minute for a named API model, endpoint, image preset, and concurrency. A three-second average is a target for the selected acceptance profile, not a claim every provider must meet. |
| Review responsiveness | Navigation, edits, accept, and undo should update visible state in under 100 ms at p95 on the acceptance catalog, excluding image decode. Thumbnail-to-full-image transitions must never block saving an edit. |
| Review throughput | Measure reviewed images/minute on a representative set; do not fold this into provider latency. |
| Structured accuracy | For tag fields, report per-field precision/recall/F1; for free text, use a human usefulness rubric and record correction rate. Do not publish one invented universal “accuracy” number. |
| API cost | Record provider-reported usage and a versioned price table when available. The selected default OpenAI profile must demonstrate no more than $0.001/image on the acceptance set. Unknown usage or pricing is displayed as unknown, never as zero. |
| Retrieval | On a curated script-to-image benchmark, record whether an acceptable image appears in top 5 and top 10. Measure structured-only, semantic-only, and hybrid retrieval separately. |
| Resilience | Killing or canceling a run preserves committed results. Reopening converts abandoned running items to resumable work without duplicating accepted tags. |

## 3. Decisions that override or refine the initial proposal

### 3.1 Use a distinct image catalog, not the auto-edit project JSON

Each tagging project is one user-selected SQLite catalog, for example `Narnia-b-roll.mythicut-catalog`. It may reference many folder roots. The existing video project remains versioned JSON and does not gain tagging tables or provider settings.

Reason: the two lifecycles are different. Auto-edit freezes a small set of ordered recordings after analysis; an image catalog is long-lived, incrementally rescanned, concurrently reviewed, and query-heavy. Combining them would make both interfaces shallower and migrations riskier.

### 3.2 AI results are proposals; accepted revisions are the source of truth

“Tagged” cannot mean both “the model returned JSON” and “a human committed these tags.” The module stores model output as a proposal. Accepting or editing creates an accepted tag revision. Downstream search uses accepted revisions by default and can include proposals only through an explicit diagnostic option.

This preserves the requested human-review step and prevents partially reviewed output from silently entering production.

### 3.3 Publish immutable schema versions

A schema can be edited as a draft. Once used by a run, it is published as an immutable version. Editing it creates the next version. Existing tag revisions continue to point to the exact version under which they were created.

Fields and tag options need stable machine identifiers as well as editable labels. Field keys are inferred from labels; renaming a field intentionally creates a new inferred key, while renaming an option preserves its stable option ID.

### 3.4 Split file state, processing state, and review state

A single `untagged | pending | tagged | failed | skipped` column loses important information. The catalog keeps these axes separate:

- File availability: present, missing, unreadable, or replaced.
- Processing state: unqueued, queued, running, proposal-ready, failed, canceled, or intentionally skipped.
- Review state: not-ready, needs-review, accepted, or skipped.

A missing file can still have an accepted historical tag revision. A failed new proposal must not erase an older accepted revision.

### 3.5 Track observed file versions

An absolute path is not a sufficient durable identity. The same path can be replaced; a file can move; selected roots can overlap. The scanner records a canonical path plus size and high-resolution modification time for every observation. A changed observation creates a new image version and makes the old accepted tags stale for the current bytes.

SHA-256 is computed lazily when needed for relinking, replacement verification, or an explicit duplicate report. Identical bytes are not automatically merged: duplicate handling remains out of scope, as requested.

### 3.6 Do not require a native vector extension in the first release

The catalog schema reserves embedding records from the start. The first semantic implementation stores fixed-dimension vectors as SQLite BLOBs and performs exact cosine search in the worker. This is simple, deterministic, and sufficient until a measured catalog size says otherwise.

`sqlite-vec` is a reasonable later adapter, but it is still pre-1.0 and introduces native extension packaging and loading. Add it only after an acceptance-size benchmark shows exact search missing the retrieval latency target. The query interface does not change when the implementation changes.

The initial embedding profile is the pinned `onnx-community/bge-small-en-v1.5-ONNX` revision `4a9a46c7b88fa408e650a571a1800243f26309bd`, loaded through Transformers.js and ONNX Runtime. It produces normalized 384-dimensional vectors from human-readable tag text. The quantized model cache is about 33 MiB, below the project's 200 MiB threshold for treating a model as a separate optional download. Development builds populate a managed cache on the first explicit **Update embeddings** action; the packaged-release delivery mechanism remains release work.

### 3.7 Do not introduce React or TypeScript only for this module

The accepted auto-edit plan names React and TypeScript, but the repository currently ships plain HTML, CSS, JavaScript, ESM domain modules, and CommonJS Electron files with no build step. Phase 1 follows the code that actually exists. A future whole-application migration can move both screens together; creating two UI toolchains now would add cost without improving the tagging seam.

### 3.8 Use OpenAI first, with a provider seam for other hosted APIs

Provider differences belong behind a real internal seam:

1. OpenAI Responses API is the default and first fully supported adapter. It sends image input and requests strict structured output for the active tag schema.
2. A configurable OpenAI-compatible HTTP adapter supports other hosted endpoints that implement the required image and structured-output behavior.
3. Anthropic Messages and Google Gemini are additional adapters, implemented only when needed and supported only after their shared contract suites and real smoke tests pass.

The tagging module owns prompt construction, mandatory image downscaling, schema compilation, result validation, retry policy, and provenance. Adapters only translate transport and provider response formats. MVP ships the OpenAI adapter plus configuration and contract support for an alternate hosted endpoint. Running or discovering local inference servers is explicitly out of scope.

`gpt-4o-mini` is the initial cost-oriented OpenAI baseline because it accepts image input and supports Structured Outputs. The exact default remains a provider profile setting and must pass the M0 accuracy/cost benchmark before release; the architecture does not hard-code one model ID into catalog logic.

### 3.9 Downscale every API-bound image

The original image never leaves the source folder and is never sent directly. Image Preparation always creates a separate, oriented, metadata-free derivative before an AI request. The default economy preset limits the longest edge to 1024 px, preserves the full aspect ratio without cropping, and normally encodes an opaque image as JPEG quality 80. The OpenAI request uses `detail: low` by default.

Higher-detail presets are explicit because character identity, small objects, or text may need more pixels:

| Preset | Client-side derivative | OpenAI detail | Intended use |
| --- | --- | --- | --- |
| Economy (default) | Longest edge 1024 px, JPEG quality 80 | `low` | Broad scene, setting, mood, action, and subject tags at minimum cost |
| Balanced | Longest edge 1536 px, JPEG quality 85 | `high` | Character identity and moderately small details |
| Detail | Longest edge 2048 px, JPEG quality 88 | `high` | Text or small-object schemas after a measured accuracy need |

Do not enlarge smaller images. PNG is retained only when transparency materially affects interpretation; otherwise use JPEG. A run records the derivative dimensions, encoded byte size, preset version, and provider detail value. Changing a preset creates new proposals rather than altering old provenance.

Downscaling is required, but the exact billing benefit depends on the selected OpenAI model and detail mode. OpenAI meters vision inputs as image tokens and applies model/detail-specific resizing or patch/tile rules, so cost tests must use actual reported usage rather than assuming file-size reduction equals token reduction.

## 4. System architecture

```text
┌──────────────────────── sandboxed renderer ────────────────────────┐
│ Tagging window: setup · queue · review · search                    │
│ window.imageTagging.execute(command) + onEvent(listener)           │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ validated IPC; no arbitrary paths
┌──────────────────── Electron main process ─────────────────────────┐
│ Window lifecycle · native dialogs · origin checks · secret decrypt │
│ authorized mythicut-image:// thumbnail/full-image protocol         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ private worker messages
┌──────────────────── long-lived utility process ────────────────────┐
│ Image Catalog module                                               │
│ scan → prepare → tag proposal → validate → persist → embed          │
│ schema versions · job recovery · review revisions · hybrid search  │
│                                                                    │
│ SQLite (single writer)   Provider adapters   Image/embedding tools │
└───────────────────────────────┬─────────────────────────────────────┘
                                │ accepted-only query interface
┌──────────────────── downstream production modules ─────────────────┐
│ Script/b-roll matcher · future auto-edit integration · CLI tooling │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.1 External seam: Image Catalog

The deep module presents one command interface, one event stream, and a lifecycle:

```js
const catalog = await openImageCatalog({ databasePath, adapters, clock });

await catalog.execute(command, { signal });
const unsubscribe = catalog.onEvent(event => { /* progress/state invalidation */ });
await catalog.close();
```

Callers do not receive a database handle, provider client, or mutable internal model. Tests use the same command interface. `adapters` contains only dependencies that genuinely vary: provider transport, image preparation, secret resolution, and clock/ID generation for deterministic tests.

Renderer IPC mirrors this shape but does not expose `databasePath` or adapter construction. Catalog creation/opening and folder selection use native dialogs in the main process.

### 4.2 Command families

Commands are discriminated objects with strict allowlists and size limits. Suggested v1 families:

| Family | Commands |
| --- | --- |
| Catalog | `catalog.create`, `catalog.open`, `catalog.close`, `catalog.snapshot`, `catalog.backup` |
| Roots | `roots.choose`, `roots.update`, `roots.remove`, `roots.scan` |
| Schema | `schema.createDraft`, `schema.updateDraft`, `schema.duplicate`, `schema.publish`, `schema.activate`, `schema.archive` |
| Provider | `provider.listProfiles`, `provider.saveProfile`, `provider.test`, `provider.setActive` |
| Runs | `run.start`, `run.cancel`, `run.resume`, `run.retryFailed`, `run.skipItems` |
| Review | `review.open`, `review.accept`, `review.editAndAccept`, `review.undo`, `review.redo`, `review.bulkAccept`, `review.bulkApply` |
| Search | `search.query`, `search.explain` |

`catalog.snapshot` is filtered and paged; it never sends an entire large catalog to the renderer. Mutating results return the new catalog revision and the smallest affected view model. Events tell the renderer which query/view is stale rather than pushing database rows blindly.

### 4.3 Events

Every event includes `schemaVersion`, `catalogId`, `eventId`, and an ISO timestamp. Job events also include `jobId` and, for item-specific events, `runItemId` and `imageVersionId`.

- `catalog.changed`: revision and affected resource IDs.
- `scan.progress`: roots/files visited, new, unchanged, replaced, missing, unsupported, and errored.
- `run.progress`: queued/running/succeeded/failed/canceled counts and current display path.
- `proposal.ready`: image ID and review sort key; never includes image bytes or secrets.
- `run.paused`: reason such as circuit breaker, provider unavailable, or credentials unavailable.
- `run.completed`: durable summary and measured usage.
- `embedding.progress`: separate from tag readiness so embedding failure does not discard valid tags.

The renderer can show completed proposals immediately while later items are still running.

## 5. Module map and ownership

| Module | Interface and responsibility | Must not own |
| --- | --- | --- |
| Image Catalog | Execute validated commands, coordinate transactions, expose snapshots/events | Electron UI, provider-specific payloads, arbitrary SQL from callers |
| Schema | Create drafts, validate/publish immutable versions, compile provider JSON schema and value validation rules | Calling models or updating review state |
| Scanner | Reconcile roots with image and image-version records; apply include/exclude policy idempotently | Tagging, schema edits, or automatic duplicate merging |
| Image Preparation | Validate/decode, apply orientation, generate bounded AI input and thumbnail cache | Persisting tags or choosing provider retry behavior |
| Tagging Job | Claim work durably, prepare prompts, call a provider, validate proposals, enforce retry/circuit policy | Renderer state or accepted-tag mutation |
| Provider Adapter | Probe capabilities and translate one provider dialect to/from the canonical generation request | Prompt policy, schema semantics, persistence, or repair decisions |
| Review | Apply accept/edit/undo commands as immutable revisions and update the active pointer transactionally | Provider calls or image scanning |
| Embedding | Build canonical retrieval text, version it, generate/store vectors | Deciding which image is editorially correct |
| Search | Apply structured filters, lexical/semantic ranking, accepted-only policy, and stable pagination | Direct UI rendering or provider configuration |
| Secrets | Resolve a credential reference in the main process using OS-backed encryption or an environment variable | Exposing plaintext through IPC, snapshots, logs, or catalog exports |

The deletion test is important here: deleting Image Catalog should force callers to reimplement migrations, file reconciliation, revision safety, validation, job recovery, and retrieval policy. Deleting a provider adapter should only remove that provider.

## 6. Persistence design

### 6.1 SQLite ownership and settings

Use the `node:sqlite` module already present in Node 24 and Electron 44. Keep its synchronous connection inside the utility process so database work cannot block the renderer or Electron main loop. This avoids a separately compiled SQLite Node add-on.

When implementation begins, raise the command-line runtime requirement in `package.json` from the current broad `node >=22` to Node 24 or later. Electron already embeds Node 24, and one supported runtime contract is safer than depending on the changing `node:sqlite` surface across early Node 22 minors.

Use one connection and one writer. At open:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```

Migrations are ordered SQL files applied inside a transaction and tracked in a dedicated `migrations` table, not only `PRAGMA user_version`. Opening a database from a newer unsupported schema version is read-only with a clear error. Backups use SQLite's backup facility to a user-selected file; copying a live WAL database is not an accepted backup strategy.

### 6.2 Core tables

The exact DDL belongs in migrations, but these records and relationships are required.

| Table | Important columns and constraints |
| --- | --- |
| `catalogs` | `id`, `name`, `created_at`, `updated_at`, `revision`, `active_schema_version_id`, `active_provider_profile_id`, `active_embedding_profile_id`; one logical row per database |
| `roots` | `id`, `display_path`, `canonical_path`, `recursive`, `include_json`, `exclude_json`, `enabled`, timestamps; canonical path unique within catalog |
| `images` | `id`, `canonical_path`, `display_path`, `filename`, `availability`, `active`, `current_version_id`, first/last-seen timestamps; canonical path unique. Inactive images remain recoverable but are omitted from the normal grid, embedding index, and retrieval results. |
| `image_roots` | `image_id`, `root_id`, `relative_path`; unique per pair; supports overlapping roots without duplicate queue items |
| `image_versions` | `id`, `image_id`, size, high-resolution mtime, optional SHA-256, media type, width, height, orientation, observed timestamp; fingerprint tuple unique per image |
| `tag_schemas` | `id`, `name`, `description`, `archived`, timestamps |
| `tag_schema_versions` | `id`, `schema_id`, monotonic version, canonical definition JSON, definition hash, published timestamp; immutable after publish |
| `tag_options` | `id`, `schema_id`, `field_id`, inferred `option_key`, editable label, archived flag, timestamps; mutable vocabulary for `tags` fields, independent of published schema structure |
| `provider_profiles` | `id`, dialect, endpoint, model, non-secret settings, `credential_ref`, last capability result, last verified time; never plaintext credentials |
| `runs` | `id`, schema version, provider/model snapshot, prompt hash/template snapshot, image preset, user prompt, status, counters, usage/cost summary, timestamps |
| `run_items` | `id`, `run_id`, `image_version_id`, state, attempt count, next attempt time, lease timestamp, error category/message, proposal revision ID, timings/usage; unique run/image version |
| `tag_revisions` | `id`, `image_version_id`, `schema_version_id`, parent revision, origin (`ai_proposal`, `ai_accept`, `manual`, `bulk`), kind (`proposal`, `accepted`), run item, model/prompt provenance, raw response reference, author/timestamps; immutable after insert |
| `tag_values` | `revision_id`, `field_id`, ordinal, typed scalar columns; uniqueness prevents duplicate ordinals and invalid field ownership |
| `active_tags` | `image_version_id`, `schema_version_id`, `accepted_revision_id`, review state, updated time; one active accepted pointer per image version/schema |
| `review_drafts` | `image_version_id`, `schema_version_id`, base/proposal revision IDs, validated draft values, updated time; mutable autosave state that is never returned by accepted-only search |
| `embedding_profiles` | catalog, provider/model/revision, dimension, normalization, pooling, query prefix, retrieval-text version, and configuration snapshot; profiles prevent incompatible vectors from being mixed |
| `embedding_runs` / `embedding_run_items` | incremental update state, counters, per-image document hash, outcome, and bounded error details; interrupted runs are recoverable and valid old documents remain searchable |
| `retrieval_documents` / `retrieval_tag_values` | one current accepted retrieval projection per image/profile plus normalized structured values used for filters and boosts |
| `retrieval_embeddings` | profile, retrieval-document hash, dimension, little-endian Float32 vector BLOB, and created time; unique by document/profile |
| `retrieval_fts` | SQLite FTS5 projection of the deterministic human-readable retrieval text |
| `audit_events` | bounded operational events needed for support and crash diagnosis; payloads are redacted and size-limited |

Do not store thumbnails, resized AI images, or raw image bytes in SQLite. Store those as regenerable cache files keyed by image-version ID plus transform version.

Reusable global provider profiles live in the app's user-data configuration, alongside their credential references. Selecting one for a catalog creates a catalog binding with optional non-secret overrides. A run always snapshots the effective endpoint/model/settings, so later edits to either the global profile or catalog override cannot change provenance. Moving a catalog to another machine leaves the binding visibly unresolved until the user maps it to a local/global profile there.

### 6.3 Schema definition contract

A published schema definition is canonical JSON:

```json
{
  "schemaVersion": 1,
  "fields": [
    {
      "id": "field_uuid",
      "key": "characters",
      "label": "Characters",
      "type": "tags",
      "options": [
        { "id": "option_uuid", "key": "lucy", "label": "Lucy" }
      ]
    },
    {
      "id": "field_uuid_2",
      "key": "scene_description",
      "label": "Scene Description",
      "type": "free_text",
      "includeInRetrievalText": true
    }
  ]
}
```

Rules:

- Field keys are inferred from labels, match `[a-z][a-z0-9_]{0,63}`, and are unique in a version. They are an internal interoperability detail, not a required GUI input.
- Tag option keys are inferred from labels and are unique within a field. Their editable human labels live in `tag_options`, not in the immutable schema structure.
- Human-visible labels are nonempty and may contain Unicode.
- A published version has at least one field and no more than 100 fields; operational text/list limits protect the prompt and database even though the product does not expose arbitrary validation rules.
- AI output structurally includes every field. `null` means unknown for free text, and `[]` means no recognized values for tags. Values outside the active tag vocabulary are invalid proposals, not automatically added by the model.
- Stored values reference stable field and option IDs. Machine keys are included in export/query results for readability and interoperability.
- `includeInRetrievalText` is configurable and avoids hard-coding a field named “Scene Description.” Tag and free-text fields may opt in.

The schema's field structure and the tag vocabulary are deliberately separate. Publishing freezes field IDs, field types, ordering, and free-text/tag behavior. A user can append a new label to an active `tags` field at any time; the catalog infers its key, records it in `tag_options`, and includes it in future prompts. A run snapshots the effective vocabulary in its prompt snapshot, so adding a value cannot change an in-progress or historical run.

### 6.4 Revision and undo semantics

Accept/edit/undo are small database transactions:

1. Validate the command against the image version, schema version, current active revision, and catalog revision.
2. Insert a new immutable accepted revision. A direct accept copies the validated proposal values and points back to that proposal; the proposal itself never changes kind.
3. Update the `active_tags.accepted_revision_id` pointer.
4. Increment catalog revision and append a redacted audit event.
5. Commit, then emit `catalog.changed`.

Undo moves the active pointer through recorded parent/command history; it does not delete a revision. Redo is valid only while the history cursor has not branched. An edit after undo creates a branch and invalidates the old redo path, matching the current transcript-review behavior.

## 7. Scanning and freshness

### 7.1 Root and pattern behavior

- Folder selection is multi-select through Electron's native dialog.
- Root settings are persistent. A run may use all enabled roots or an explicit subset.
- Include image extensions case-insensitively: JPEG/JPG, PNG, WebP, TIFF, BMP, GIF first frame, and AVIF where the chosen decoder passes fixtures. HEIC/HEIF support is capability-tested and shown as unsupported when unavailable.
- Excludes use catalog-relative POSIX-style glob syntax regardless of host separator. Normalize before matching; never interpret an exclude as a shell pattern.
- Do not follow directory symlinks by default. A future opt-in must include cycle detection.
- Hidden files/folders are excluded by default and configurable per root.
- A root removal removes membership, not accepted tag history. An explicit compact/purge workflow is future work and must show a destructive confirmation.

### 7.2 Idempotent reconciliation

Each scan runs in bounded batches so the worker can cancel and emit progress. It performs:

1. Enumerate a root according to recursion and exclusion policy.
2. Normalize/canonicalize each path without resolving outside the selected root through symlinks.
3. Upsert image/root membership.
4. Compare size and high-resolution mtime to the current image version.
5. Reuse unchanged versions; create a new version for changed bytes/metadata observations.
6. Probe/decode new versions and mark unreadable files without stopping the scan.
7. Mark previously observed but unseen membership missing only after the root completes successfully. A canceled or failed scan never declares unseen files missing.
8. Queue only current, readable versions without an accepted/proposed result for the active schema, unless force-retag is explicit.

“Update index” is therefore `roots.scan` plus an optional `run.start` over the new/stale result set. It is not a second indexing implementation.

### 7.3 Image preparation and cache

Use a single image library in the utility process for metadata, orientation, thumbnails, and AI payloads; `sharp` is the initial candidate. Verify its Intel macOS and packaged Electron behavior in M0 before adopting it.

API-bound preparation is mandatory; there is no “send original” path. Default economy preset:

- Apply EXIF orientation.
- Preserve aspect ratio.
- Limit the longest edge to 1024 px without enlarging smaller images.
- Encode opaque images as JPEG quality 80; retain PNG only when meaningful transparency would be lost.
- Strip metadata from transmitted/resized bytes.
- Never overwrite the source.
- Set OpenAI image detail to `low`; Balanced and Detail presets opt into `high`.

Cache keys include image-version ID, transform version, dimensions, format, and quality. A cache failure may slow a future view but must not invalidate accepted tags.

The renderer loads images only through an application protocol such as `mythicut-image://thumbnail/<version-id>`. The main process resolves IDs through the catalog, serves only authorized files/cache entries, and never accepts a raw renderer-supplied filesystem path.

The worker checks encoded dimensions, byte size, MIME type, and transform identity before every request. This prevents a cache bug or alternate adapter from bypassing the downscaling policy.

## 8. AI provider and prompt design

### 8.1 Canonical provider request

```js
await provider.generate({
  endpointProfile,
  model,
  systemText,
  userText,
  image: { bytes, mediaType },
  outputSchema,
  imageDetail,
  timeoutMs,
  signal
});
```

The result contains response text or structured data, provider request ID when available, measured timings, token/image usage when available, and a normalized error category. It never decides whether a value is valid.

For OpenAI, the adapter uses the Responses API with an image input and strict JSON-schema output. The default profile uses `gpt-4o-mini` as the benchmark candidate, `detail: low`, minimal text output, and no conversational history. Model and detail are configurable, but a model cannot be selected until `provider.test` verifies both image input and the active schema shape.

Provider capability probing records:

- endpoint reachable;
- model list, when supported;
- selected model exists;
- image input accepted;
- JSON schema, JSON-object mode, and plain-text fallback support;
- embedding support and dimensions, when configured;
- verified timestamp and a short redacted diagnostic.

A successful `/models` request is not proof that the selected model can see images or obey the schema. `provider.test` sends a bundled tiny fixture and validates a tiny schema before enabling Run.

### 8.2 Hosted provider configuration

OpenAI is preconfigured with its official HTTPS origin; the user supplies a credential reference and chooses from compatible models. Other API sources require an explicit provider profile containing adapter type, HTTPS base URL, model identifier, credential reference, timeout, and optional provider-specific headers from a strict allowlist.

There is no endpoint discovery, LAN scan, or local-server probe. Alternate endpoints must pass `provider.test` before Run is enabled. Plain HTTP endpoints are rejected.

### 8.3 Prompt compilation

The Schema module compiles one canonical schema into:

- provider-specific JSON schema;
- a concise field/option instruction block;
- a local validator;
- canonical retrieval-text rules.

The default system prompt states that the image, filename, path, and user prompt are data to classify; they cannot authorize actions. The model may only return the requested fields. User-editable templates support an allowlisted placeholder set such as `{{schema}}`, `{{filename}}`, `{{relative_path}}`, and `{{extra_instructions}}`; unknown placeholders fail validation before a run.

Store the exact template, extra prompt, compiled-schema hash, provider profile snapshot, model name, and image-preset version on the run. This makes results reproducible enough to compare even when the live profile later changes.

### 8.4 Validation and repair

Validation order:

1. Accept native structured data when present; otherwise extract exactly one JSON object without executing or evaluating text.
2. Enforce maximum response bytes before parsing.
3. Require the exact published field set; ignore nothing silently.
4. Validate field types and tag option keys against the schema version.
5. Normalize strings and arrays deterministically; remove exact duplicate multi-values while retaining schema option order.
6. Persist valid values and a bounded/raw diagnostic response separately.

One provider retry may include validation errors and ask for corrected JSON when the adapter supports it. Do not invent missing tag values locally. A tolerant parser may remove a surrounding Markdown fence; it must not use `eval`, execute tool calls, or turn returned paths/URLs into I/O.

### 8.5 Retry and circuit policy

Classify failures rather than counting all errors alike:

| Category | Item behavior | Session behavior |
| --- | --- | --- |
| Unreadable/corrupt image | Mark image version unreadable and item skipped | Continue |
| Schema/configuration error | Do not start item | Pause run immediately |
| Authentication/permission | No blind retry | Pause run immediately and request user action |
| Rate limit/server unavailable/timeout | Retry with bounded exponential backoff and jitter, default two retries | Open circuit after five consecutive provider failures |
| Invalid structured result | One correction retry, then fail item | Continue unless five consecutive items fail validation |
| Cancellation | Abort request, mark item canceled/resumable | Stop claiming new items |

The circuit breaker is consecutive because a lifetime total of five failures could stop a healthy 50,000-image run after unrelated intermittent errors. Reset it after a successful provider response. Persist retry counts and next-attempt times so resume does not create a retry storm.

Default concurrency is one. After correctness and provider rate limits are measured, a profile may configure up to four concurrent requests. Rate-limit responses reduce effective concurrency and honor provider retry timing when available.

### 8.6 Secrets

- Store credential payloads outside the catalog under Electron user data, encrypted with asynchronous `safeStorage` where available.
- The catalog stores only a random `credential_ref` and display hint.
- Environment-variable credentials store only the variable name. Resolve its value inside the worker at request time.
- The main process decrypts app-managed credentials and transfers them directly to the utility process; plaintext never crosses the renderer bridge.
- Redact authorization headers, query tokens, response bodies beyond the diagnostic limit, and known secret values from errors/logs.
- Detect and refuse an insecure Linux `basic_text` backend for persistent app-managed keys; offer an environment variable instead.
- Packaging/signing is an acceptance gate on macOS because consistent signing affects Keychain behavior.

## 9. Durable processing pipeline

### 9.1 Run creation

`run.start` receives root IDs, a published schema version, provider profile, extra prompt, and explicit selection policy:

- `new_only` (default): current readable image versions with neither accepted tags nor a proposal for this schema version;
- `retry_failed`: current readable image versions whose latest tag attempt for this schema failed;
- `stale_only`: current versions whose accepted tags belong to replaced bytes or an older selected schema version;
- `force_all`: create new proposals without changing accepted revisions.

The command resolves the target set in one transaction and inserts unique run items. It returns quickly; the worker then claims items.

### 9.2 Per-image stages

```text
claim → verify source version → prepare image → compile prompt
      → provider call → parse/validate → persist proposal
      → enqueue embedding after acceptance → emit proposal.ready
```

Persist a valid proposal and mark its item successful in one transaction. The UI may review it immediately. Embedding is intentionally after acceptance by default, avoiding spend on proposals a reviewer will replace; an opt-in can embed proposals for evaluation.

### 9.3 Recovery and cancellation

- A run item has a lease timestamp. On open, an expired `running` lease returns to queued unless its proposal transaction committed.
- The worker checkpoints every item, not every N items.
- Cancel stops claiming, aborts the active provider request, and leaves untouched queue items resumable.
- Closing the window requests graceful worker shutdown, then terminates after a short deadline. The lease mechanism handles forced termination.
- Starting another run against the same image/schema never overwrites the accepted pointer.
- Only one active writer worker opens a catalog. A second window receives a read-only/already-open response rather than relying on SQLite contention.

## 10. Review experience

### 10.1 Layout

Use one tagging window with four top-level views:

1. **Setup** — catalog, roots, schema drafts/versions, provider profile, test connection, run settings.
2. **Queue** — durable run status, current item, aggregate progress, failures, retry/pause/cancel controls.
3. **Review** — list/batch and single-image modes over the same filtered review query.
4. **Search** — exercise the exact downstream query interface and explain why each image matched.

### 10.2 List/batch review

- Paged/windowed rows; never render the whole catalog DOM.
- Thumbnail, filename/relative path, process/review state, compact field editors, error indicator, and accept action.
- Filter by folder, status, schema version, run, field values, missing tags, and text.
- Stable sort options: completion time, path, review state, and run order.
- Multi-select with bulk accept and bulk apply. Bulk actions create one accepted revision per image inside bounded transactions, with a shared audit group ID.
- Keyboard: arrows move, Space selects, Enter opens, `A` accepts, `E` focuses first field, Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z redo.

### 10.3 Single-image review

- Large authorized image preview; previous/next are prefetched by ID, not raw path.
- All schema fields visible in published order.
- Tag chips with searchable option controls; free text is selectable/editable.
- `Accept & next`, `Save edit & next`, skip, undo/redo, and jump to first invalid/empty field.
- Navigation does **not** implicitly accept an untouched proposal. Dirty manual edits auto-save as a draft or require the explicit accept shortcut; silently committing merely by navigating is too easy to trigger accidentally.
- A user setting may enable “accept unchanged proposal on next,” but its state must be visible.

### 10.4 Focus points

Defer pins until the tag/review workflow passes. When added, store normalized coordinates after EXIF orientation (`x` and `y` in `[0,1]`) plus optional stable field/option reference and note. Never store absolute pixels alone because display and source resolutions differ. Pins use the same immutable revision pattern as tags.

## 11. Retrieval interface for the production pipeline

Do not expose arbitrary SQL as the module interface. Add `src/image-tagging/search.mjs` for in-process consumers and a thin CLI for manual verification.

```js
const result = await catalog.execute('search.hybrid', {
  semanticText: 'Lucy discovers a snowy magical forest',
  bookKeys: ['the_lion_the_witch_and_the_wardrobe'],
  centralCharacterKeys: ['lucy'],
  settingKeys: ['snowy_forest'],
  moodKeys: ['wonder'],
  imageTypeKeys: ['illustration'],
  limit: 5
});
```

Return:

- image ID/version, current authorized path/URI, dimensions, and availability;
- accepted schema and tag revision identities;
- structured tag values;
- structured, lexical, semantic, and final score components;
- compact provenance, not raw provider reasoning;
- the latest current-version object-detection result and bounding boxes for downstream animation anchors; detections never participate in search scoring.

Retrieval rules:

1. Only active images with accepted tags for their current image version and active schema are candidates. Missing/unreadable and deactivated images are excluded.
2. At least one inferred book is required. Books are an exact `containsAny` hard filter; a query without a book returns a structured `missing_book` result.
3. When named central characters are supplied, at least one must match an image's canonical character tags. Generic concepts such as person, animal, object, or landscape do not satisfy this constraint.
4. Setting, mood, and image type are soft signals. Character match ratio is the strongest structured boost after hard filtering; setting is next, with mood and image type tertiary.
5. SQLite FTS5 lexical rank and normalized exact-vector cosine rank are fused with reciprocal-rank fusion. Small structured boosts adjust the fused score, and image ID provides a deterministic tie-break.
6. Semantic scoring uses only the catalog's active embedding profile. Profile identity includes model revision, dimension, pooling, normalization, query prefix, and retrieval-text version.
7. No hard cosine threshold is applied initially. The downstream selection LLM may reject all candidates or reformulate the query.
8. Results include lexical, semantic, reciprocal-rank, structured-boost, and final score components for auditing.

### 11.1 Embedding text

Build deterministic text from all six tagging fields—character, book, setting, image type, mood, and scene description—using human-readable labels and values in a stable order. Hash the exact text. Human labels make both lexical matches and embedding input resemble the natural-language query rather than opaque canonical keys. Editing accepted tags changes the hash; the next incremental update excludes the stale changed document until its replacement vector is written. Unchanged vectors are reused.

The embedding implementation is independent from the vision-tagging provider. The initial profile is the pinned local BGE Small ONNX model described in section 3.6. Document embeddings use CLS pooling and normalization; query embeddings additionally use the model's retrieval instruction prefix. Store the complete profile identity with every vector and never mix profiles in one similarity comparison.

### 11.2 Vector implementation upgrade rule

Begin with exact cosine search over BLOB vectors in the worker. Benchmark p50/p95 using the expected dimensions at 1k, 10k, and the user's projected catalog size. Add a `sqlite-vec` adapter only when either:

- accepted-size p95 exceeds 250 ms for a top-20 query, or
- memory use is unacceptable on the target machine.

The Search module remains the external seam; vector details stay internal.

## 12. Security and privacy

- Keep `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false` for the tagging renderer.
- Use a dedicated `tagging-preload.cjs`; do not broaden `window.projects` or expose `ipcRenderer` directly.
- Validate IPC sender, frame origin, command shape, IDs, lengths, tag values, and expected catalog revision in the main/worker path.
- Keep the tagging page local with a restrictive CSP. Provider network calls occur only in the utility process.
- Native folder/file dialogs create path authority. The renderer never supplies a path to read.
- The custom image protocol resolves opaque IDs and verifies current catalog membership.
- Treat filenames, paths, EXIF text, image text, provider output, and user prompt as untrusted data. Render with `textContent`, never `innerHTML`.
- Do not send EXIF metadata to providers. Every run confirmation states that downscaled image derivatives will leave the machine, names the destination provider/origin, model, detail preset, and estimated target count.
- Allow remote calls only to the saved/tested provider origin. Redirects to another origin are rejected unless retested.
- Logs contain IDs and display-safe relative paths where possible. Raw provider responses are bounded, access-controlled to diagnostics, and removable.
- Never allow model output to add roots, read another file, change provider configuration, create schema options, or execute a command.

## 13. Proposed repository layout

```text
src/image-tagging/
  index.mjs                 # openImageCatalog external interface
  catalog.mjs               # command dispatch and transaction orchestration
  database.mjs              # node:sqlite connection, statements, backup
  migrations.mjs            # ordered migration runner
  migrations/
    001-initial.sql
  schema.mjs                # drafts, publish, compile and value validation
  scanner.mjs               # root reconciliation and image versions
  image-preparation.mjs     # metadata, orientation, thumbnail/AI transforms
  tagging-job.mjs           # durable claims, retry, circuit, recovery
  prompt.mjs                # canonical prompt/template compiler
  review.mjs                # immutable accepted revisions and history
  embedding.mjs             # retrieval text and embedding lifecycle
  search.mjs                # accepted-only structured/hybrid retrieval
  providers/
    openai.mjs
    openai-compatible.mjs
    anthropic.mjs
    google.mjs
    errors.mjs
  testing/
    fake-provider.mjs
    fake-image-preparation.mjs

electron/
  tagging.html
  tagging.css
  tagging.js
  tagging-preload.cjs
  tagging-ipc.cjs
  tagging-worker.cjs
  tagging-smoke.cjs

scripts/
  tagging-search.mjs        # downstream/query verification CLI
  tagging-benchmark.mjs     # latency, memory, cost, retrieval benchmark

test/image-tagging/
  catalog.test.mjs
  migrations.test.mjs
  schema.test.mjs
  scanner.test.mjs
  tagging-job.test.mjs
  review.test.mjs
  search.test.mjs
  provider-contract.test.mjs
```

Expected existing-file changes:

- `electron/main.cjs`: add `--tagging` mode and construct the dedicated window/preload/IPC registration without adding tagging commands to project IPC.
- `package.json`: add `npm run tagging`, tagging smoke/benchmark scripts, the official OpenAI JavaScript SDK, and the selected image dependency after M0.
- `README.md`: document how to open and verify the module once its first vertical slice works.

Do not put tagging logic into `src/project.mjs`, `electron/project-ipc.cjs`, or `electron/project.js`.

## 14. Implementation roadmap and exit gates

### M0 — risk spikes and accepted fixtures

Work:

- Build a minimal Electron utility-process spike using `node:sqlite`, migrations, WAL, close/reopen, and backup.
- Verify the embedded SQLite compile options needed by the plan, especially FTS5; if FTS5 is absent, use a normal indexed text table until a packaging-safe alternative is selected.
- Benchmark candidate image preparation on the user's 2019 Intel Mac using representative JPEG/PNG/large images; verify orientation, color, alpha, and packaged loading.
- Test the OpenAI Responses adapter against a small dynamic schema using the Economy, Balanced, and Detail image presets.
- Measure the current cost-oriented OpenAI model candidates on the acceptance set and select a default only from recorded accuracy, latency, and usage evidence; begin with `gpt-4o-mini` as the baseline.
- Prove an alternate hosted provider can satisfy the canonical provider contract without changing the Image Catalog interface; a fake endpoint is sufficient for the architecture gate, while real-provider support requires its own smoke test.
- Capture provider capability/response fixtures with credentials and image content removed.
- Assemble a licensed/private acceptance set covering portraits, groups, landscapes, ambiguous characters, dark frames, text-heavy images, corrupt files, and duplicate filenames in different roots.
- Record expected catalog size and vector dimension assumptions.

Exit gate:

- Electron's embedded runtime opens and backs up the database successfully.
- The selected decoder/preparer works unpackaged and in a packaged smoke build on the target Mac.
- OpenAI produces validated tag-array and free-text output through the Responses API.
- Every transmitted test image is a derivative within the selected dimension/detail limits, with source metadata removed.
- The chosen OpenAI profile has measured accuracy, latency, and per-image usage for all three presets.
- Measured latency/cost is recorded; unsupported goals are visible rather than assumed.

### M1 — catalog and schema vertical slice

Work:

- Implement migrations, catalog create/open/close/backup, catalog revisioning, and typed command validation.
- Implement schema draft, option management, duplicate/reorder, immutable publish, activate, and archive.
- Build the dedicated tagging window shell, preload, IPC origin checks, worker lifecycle, Setup view, and disposable smoke catalog.

Exit gate:

- Create a catalog, publish two schema versions, reopen it, and prove v1 remains unchanged.
- Interrupted/failed migration leaves the last supported database usable.
- Renderer has no Node/database/path access and invalid commands make no mutation.

### M2 — roots, scanning, thumbnails, and update index

Work:

- Native multi-folder selection and persistent per-root recursion/excludes.
- Idempotent scanner, overlapping-root membership, image versions, missing/replaced state, cancel/resume.
- Thumbnail/AI image transforms and authorized custom protocol.
- Queue selection previews showing exactly what new-only/force/stale will process.

Exit gate:

- Repeated unchanged scans create no new versions or queue items.
- Replacing bytes at one path creates a new version without deleting old accepted history.
- A canceled scan does not mark unseen files missing.
- Corrupt, unsupported, Unicode, long, and Windows-style path fixtures fail safely.
- The UI scrolls a 10k-row synthetic catalog without creating 10k DOM image nodes.

### M3 — provider configuration and durable proposals

Work:

- Implement the OpenAI Responses adapter, generic OpenAI-compatible hosted adapter, profile testing, and secrets.
- Implement prompt/schema compilation, image input, strict validation, bounded repair, provenance, usage/cost accounting.
- Implement durable runs/items, leases, retries, circuit breaker, pause/cancel/resume, and live events.
- Build Queue UI and stream proposal-ready rows into Review.

Exit gate:

- Fake-provider contract tests cover success, timeout, auth, rate limit, malformed/oversized JSON, unknown tag options, cancel, and crash after provider response/before commit.
- One real OpenAI smoke run completes without exposing a key in the database, renderer state, cache metadata, or logs.
- Captured requests prove original images are never transmitted and all API-bound images conform to their saved preset.
- Closing/reopening during a run neither loses committed proposals nor duplicates them.
- Run summaries reconcile item counts and provider usage exactly.

### M4 — review, accepted revisions, and batch work

Work:

- Implement paged list and single-image review over shared queries.
- Field editors generated entirely from the published schema.
- Accept, edit-and-accept, skip, undo/redo, accept-and-next, multi-select, bulk accept/apply, shortcuts, and filters.
- Stale/replaced-file and old-schema warnings.

Exit gate:

- No proposal appears in accepted-only queries until accepted.
- Edits and undo/redo survive reopen and never mutate an earlier revision.
- Concurrent/stale revision commands are rejected with a refresh response, not last-write-wins.
- Keyboard-only review of the acceptance set is possible.
- Review interaction p95 meets the responsiveness target.

### M5 — RAG-ready retrieval and downstream seam

Status: the first implementation slice is complete. It includes an in-app manual Search demo plus the CLI and catalog command. The formal relevance/latency benchmark remains deferred at the user's direction.

Work:

- Implement accepted structured filters and FTS lexical search. **Implemented.**
- Implement embedding profile, canonical retrieval text, vector persistence, exact cosine search, incremental re-embedding, deactivation, and hybrid score explanation. **Implemented.**
- Add a catalog search command and CLI using the same implementation. **Implemented.**
- Add an in-app Search demo for manually choosing structured values and inspecting ranked images and score explanations. **Implemented.**
- Create a script-to-image retrieval benchmark from representative production prompts. **Deferred by explicit product decision.**

Exit gate:

- Search never mixes embeddings from different model/dimension/text versions.
- Editing accepted tags invalidates/rebuilds only the affected active embedding.
- Structured filters and top-k results are deterministic.
- Retrieval quality and p50/p95 latency are reported at projected catalog size.
- The Search interface can be consumed without importing Electron or provider modules.
- Decide from evidence whether exact search remains or `sqlite-vec` work is justified.

### M6 — release hardening and optional provider breadth

Work:

- Complete remaining provider adapters and their real smoke tests only if needed.
- Packaging/signing, Keychain behavior, database backup/restore drill, cache cleanup, diagnostics export/redaction.
- Full acceptance run on representative folders; measure tag latency, review throughput, correction rates, retrieval, cost, peak memory, cancel/recovery.
- Add focus points only after all M1–M5 gates pass; otherwise move them to v1.1.

Exit gate:

- A clean packaged install can create, tag, review, reopen, query, back up, and restore a catalog.
- No plaintext managed secret exists in the catalog or exported diagnostics.
- Selected acceptance provider/profile meets the declared cost target or the UI/README clearly records why it does not.
- Known unsupported formats/providers/platforms are explicit.

## 15. Test strategy

The Image Catalog interface is the test surface. Internal pure helpers get focused tests where their invariants are complex, but the suite should not mirror every internal function.

### Unit/interface tests

- Schema key/option rules, canonical hashes, immutable publication, output compilation/validation.
- Review revision and branching undo/redo behavior.
- Retry classification, backoff bounds, and circuit reset.
- Retrieval text, filter semantics, score normalization, stable tie-breaking.

### Database/migration tests

- Every historical fixture migrates to latest and reopens.
- Migration transaction rollback on injected failure.
- Foreign keys, unique run items, active revision ownership, and stale command conflicts.
- Backup while catalog is open, then integrity check and functional reopen of the backup.

### Scanner/image integration tests

- Nested/excluded/hidden folders, overlapping roots, symlinks, Unicode/case behavior, duplicate filenames.
- Unchanged, touched-only, replaced, moved-with-hash, deleted, unreadable, and canceled scan cases.
- EXIF orientations, alpha, large dimensions, animated first frame, corrupt/truncated image.
- Source files are byte-identical before/after all operations.

### Provider contract tests

Run every adapter against the same fake HTTP scenarios and canonical expectations. Real provider tests are opt-in and record only redacted capability summaries. A provider is not labeled supported merely because its endpoint responds.

### Electron smoke tests

Use a disposable catalog and fixture folders. Verify sandbox/preload restrictions, folder-dialog injection seam, streamed proposal appearance, edit/accept/undo, application-restart recovery, image protocol authorization, and no destructive writes to source folders.

### Acceptance and performance tests

Report machine, Electron/Node versions, provider/model, endpoint location, schema hash, image preset, image mix/dimensions, cache state, concurrency, elapsed distribution, usage/cost, peak memory, review corrections, and retrieval metrics. Preserve raw benchmark JSON plus a readable Markdown summary.

## 16. Definition of done

The tagging module is production-usable when a packaged MythiCut Studio build can:

1. Create/open/back up an independent image catalog.
2. Manage and publish general-purpose schema versions in the GUI.
3. Reconcile multiple selected folder roots without modifying source images.
4. Test and use OpenAI vision models securely while allowing other hosted API adapters to be configured.
5. Run, stream, cancel, crash-recover, and resume durable tagging jobs.
6. Keep AI proposals separate from human-accepted immutable revisions.
7. Support fast keyboard review, editing, batching, and undo/redo.
8. Query only accepted current-image tags through structured and semantic retrieval.
9. Demonstrate measured latency, cost, correction, retrieval, and recovery results on the acceptance catalog.
10. Keep every Narnia-specific schema or prompt in user-created catalog data rather than application code.

Focus points, export/sidecars, statistics, similarity clustering, automatic duplicate merging, broad LAN endpoint discovery, and vector ANN optimization are post-v1 unless an earlier exit gate proves one is necessary for the primary workflow.

## 17. Technical references behind the decisions

- Electron utility processes provide a Node-enabled child process and message channel suitable for keeping catalog work out of the UI process: [Electron `utilityProcess`](https://www.electronjs.org/docs/latest/api/utility-process).
- The repository-pinned Electron 44.3.0 embeds Node 24.20.0: [Electron 44.3.0 release](https://releases.electronjs.org/release/v44.3.0).
- `node:sqlite` includes the synchronous database interface and an online backup function; synchronous access is deliberately isolated in the worker: [Node.js SQLite documentation](https://nodejs.org/api/sqlite.html).
- Electron recommends sandboxing, context isolation, restrictive IPC exposure, sender validation, and CSP: [Electron security checklist](https://www.electronjs.org/docs/latest/tutorial/security).
- Electron `safeStorage` uses platform key providers and documents both asynchronous access and the insecure Linux `basic_text` fallback: [Electron `safeStorage`](https://www.electronjs.org/docs/latest/api/safe-storage).
- The OpenAI Responses API accepts image inputs, while image dimensions and `detail` select model-specific image-token processing rules: [OpenAI images and vision guide](https://developers.openai.com/api/docs/guides/images-vision).
- OpenAI Structured Outputs constrain responses to a supplied JSON schema: [OpenAI Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs).
- `gpt-4o-mini` accepts text and image inputs and supports Structured Outputs, making it the initial cost-oriented tagging baseline rather than an architectural requirement: [OpenAI `gpt-4o-mini` model](https://developers.openai.com/api/docs/models/gpt-4o-mini).
- Transformers.js supports local feature-extraction pipelines used by the pinned BGE Small ONNX retrieval profile: [Transformers.js documentation](https://huggingface.co/docs/transformers.js/index).
- `sqlite-vec` describes itself as pre-v1; that is why it is an evidence-triggered optimization rather than a v1 requirement: [`sqlite-vec` project](https://github.com/asg017/sqlite-vec).
