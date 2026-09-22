# MythiCut Studio project context

This is the short, maintained handoff for humans and coding agents. It records current boundaries, durable decisions, portability requirements, and where to verify details. Plans remain useful, but a plan item is not implemented merely because it is documented.

## Product boundary

MythiCut Studio is a local-first Electron application with two separate workflows:

1. **Auto-edit** imports ordered talking-head recordings and a script, builds recognition and matching evidence, lets the user control a word-level reviewed selection, previews that selection, and exports Final Cut Pro 7 XML for Adobe Premiere.
2. **Image catalog** scans user-selected artwork folders, proposes structured tags through a configured hosted provider, records human-reviewed tags, and exposes accepted metadata for later retrieval.

The workflows share the desktop shell and local-first posture. They do not share a persistence model: auto-edit projects use versioned JSON plus adjacent analysis artifacts, while image catalogs use independent SQLite files.

## Durable product rules

- Original recordings and artwork remain user-owned and are never modified by application workflows.
- Human review is authoritative. Automatic edit suggestions and AI tag proposals remain provisional.
- Preview and Premiere export consume the same compiled timeline revision.
- Published tag-schema structures are immutable; later structural changes create a new schema version.
- Tag vocabulary is mutable within a published schema: adding a value or retiring one does not create a schema version, and retired values remain attached to existing accepted tags.
- Provider credentials remain machine-local and encrypted. Catalogs contain references, never plaintext keys.
- Cataloged artwork is referenced by source root plus relative path. A moved drive is repaired by relocating the source root; image identity and tag history remain stable.
- Migration SQL is cross-platform: tracked SQL uses LF, and checksum verification normalizes line endings before hashing.

## What Git does and does not carry

Git is the source of truth for application code, tests, tracked documentation, migration files, and small intentional fixtures.

Git does not carry `artifacts/`, `node_modules/`, local model installations, API credentials, production recordings, artwork, auto-edit project data, generated analysis, or image-catalog databases. Those must be copied, regenerated, or reselected on a new computer.

The user’s production artwork and portable image catalog live on an external T7 drive. Treat its mount point or drive letter as variable. Open the catalog through the UI and use **Relocate** for a source root rather than hardcoding a machine-specific path.

## Current verified capabilities

### Auto-edit

- Create, save, reopen, and analyze an auto-edit project.
- Preserve the original script, ordered recording inputs, recognition evidence, manual word selections, and undo/redo history.
- Audition original source video separately from edited playback.
- Compile the reviewed selection for preview and FCP7 XML export.
- Lock the current reviewed edit as an immutable, fingerprinted phase-1 transcript handoff with retained word IDs, unchanged source timestamps, sequence-frame placements derived from the exported compiled intervals, and sentence/paragraph context. The active handoff is referenced from the project; older handoffs remain adjacent and unchanged. A separate evaluation-only importer accepts source transcription words plus the same compiled edit intervals, never timings inferred from a baked video.
- Reuse verified timing and preview work when identity matches.
- The small two-clip Premiere XML fixture has user-confirmed import correctness. This does not establish full-recording, mixed-rate, or camera-rollover correctness.

### Image catalog

- Create, open, remember, and transaction-safely save a catalog to a chosen location.
- Add and scan multiple source roots without modifying images.
- Filter the review display to selected source roots while including their scanned subfolders.
- Configure tag schemas and hosted providers, run tagging batches, and accept, edit, or undo tag reviews.
- Add or retire allowed tag values without replacing the active schema or hiding existing accepted metadata; retired values remain displayable on images that already use them and can be reactivated.
- Display pending proposals while images await review, then edit accepted tags directly in the image grid, including removing/replacing vocabulary values and editing free-text fields.
- Select image groups, accept every selected pending proposal unchanged, or apply audited bulk tag additions, removals, replacements, and free-text updates.
- Run auto-tagging in force-all mode for only the selected image versions.
- Retry only image versions whose latest tag attempt for the active schema failed.
- Reopening a catalog reconciles abandoned tag and detection work, marking in-flight items failed and unstarted queued items canceled so stale runs cannot permanently disable controls.
- Run selected-image face and prominent-object detection as a separate, cached workflow without adding regions to the searchable tag schema.
- Toggle detected face and object bounding boxes over image previews in the review grid.
- Open any grid image in a larger modal preview that shares the grid's bounding-box visibility state.
- Detection results accept both the production grouped schema and legacy flat arrays returned by some Gemini responses; flat results are classified using metadata and label heuristics before storage, with up to four prominent objects retained per image.
- Provider diagnostics log the parsed structured response and raw response text alongside request metadata.
- The image-catalog review grid loads up to 1,000 images per snapshot with lazy, asynchronously decoded large previews, filename and resolution metadata, status icons for awaiting review/errors/accepted images, and bottom-aligned review actions.
- Reopen catalogs created by pre-canonical-checksum builds and upgrade their raw migration checksums while preserving catalog data.
- Reopen a portable catalog on another operating system without migration checksum failures caused only by LF/CRLF conversion.
- Relocate a source root after a drive-name, mount-point, or drive-letter change while preserving image and tag identity.
- Generate platform-correct image preview URLs from the current catalog paths, including relocated Windows source roots.
- Deactivate cataloged images without deleting their metadata or history, exclude them from the normal grid and retrieval, and reactivate them through the catalog UI.
- Build deterministic retrieval documents from accepted metadata, generate incremental local BGE Small embeddings, and retain vectors in the portable catalog.
- Run hard-filtered hybrid image search using SQLite FTS5, exact local cosine similarity, reciprocal-rank fusion, and structured tag boosts; return current resolution and detection regions with ranked results.
- Test hybrid retrieval from an in-app demo that derives book, character, setting, mood, and image-type choices from the active schema and shows ranked images with score explanations.
- Produce and copy a compact selection packet for the downstream LLM containing visual-beat context, eligible image IDs, human-readable metadata, and ranking evidence without filesystem paths or bounding-box coordinates.
- Query the same hybrid search implementation from the image-catalog worker or the `search:images` command-line tool.

Run the tests rather than trusting counts recorded in documentation. `package.json` is authoritative for current commands and runtime versions.

## Known limits and open work

- The auto-edit full-processing performance gate is not yet established.
- Mixed frame rates, variable frame rates, nonzero stream starts, and uncertain camera rollover joins require explicit verification before being presented as supported.
- Automatic selection and timing remain review aids; uncertain boundaries must stay visible and editable.
- The image-catalog architecture document marks the implemented retrieval slice explicitly. The in-app retrieval demo is for manual inspection rather than downstream selection; a formal relevance/latency benchmark, packaged model delivery, and broader release hardening remain deferred.
- `BROLL_PIPELINE_PLAN.md` defines the locked-edit-to-artwork-to-motion integration. M1 handoff generation and persistence are implemented and covered by tests, but not yet exercised against the user's production reference edit. The whole-script context line is extractive, not a hosted-model semantic summary. Beat planning, automated artwork selection, editable motion, multi-track B-roll preview, and Premiere still-motion export are not yet verified capabilities.
- The M0 B-roll interchange experiment can generate a structurally tested synthetic still-and-tone XML fixture (`npm run m0:broll`). A corrected fixture imported into Adobe Premiere Pro 2026 on Windows with direct PNG stills, sparse V3 stacking, fill-frame images, and editable native Position/Scale keyframes observed. The FCP7 `center` parameter uses fractions of source dimensions; the first percentage-valued attempt moved art off-screen. The user confirmed continuous audio; a direct still relink succeeded. The interrupted repeat-import check remains an assumption, not verified. The user chose to proceed to M1. See `M0_BROLL_PREMIERE_CHECK.md`. This fixture does not test phase-1 source-video integration.
- The first embedding run may download the pinned quantized BGE Small model into application-managed external model storage. The verified cached payload is about 33 MiB; packaged-model bundling remains part of the unresolved release workflow.
- Windows x64 is the current verified local-embedding runtime. The catalog encoding remains platform-neutral, but other operating systems have not passed a local-model runtime acceptance run.
- The current dependency tree reports two high-severity advisories. This environment could not retrieve the registry audit details, so dependency triage remains required before a packaged release.
- A packaged, cross-platform release workflow is not yet the source of truth; development currently runs from the repository.

## New-computer handoff

1. Clone or pull the repository and confirm the working tree is clean at the intended commit.
2. Add this repository folder as a local Codex project; local project-folder access does not move between computers automatically.
3. Install the runtime and dependencies declared by the repository. Install media and recognition tools only for the workflows that require them.
4. Connect the external media drive. Open the portable image catalog through the app; relocate its source root if the drive path changed.
5. Re-enter provider credentials on the new computer.
6. Copy any required ignored auto-edit projects, recordings, models, or analysis artifacts separately. A successful Git pull does not prove those files are present.
7. Run the relevant automated checks before continuing production work.

## Source-of-truth map

| Question | Source |
| --- | --- |
| Canonical product terms | `CONTEXT.md` |
| Current handoff, boundaries, portability, and known limits | `PROJECT_CONTEXT.md` |
| Agent reading and maintenance rules | `AGENTS.md` |
| Auto-edit accepted behavior and planned milestones | `IMPLEMENTATION_PLAN.md` |
| Measured auto-edit experiments and acceptance evidence | `FEASIBILITY_STATUS.md` |
| Image-catalog architecture, security model, and roadmap | `IMAGE_TAGGING_ARCHITECTURE.md` |
| Planned phase-2 beat/artwork selection and phase-3 motion/export milestones | `BROLL_PIPELINE_PLAN.md` |
| M0 Premiere import fixture and manual acceptance checklist | `M0_BROLL_PREMIERE_CHECK.md` |
| M1 locked edit handoff and test-only reference import | `M1_LOCKED_EDIT_HANDOFF.md` |
| User-facing setup and workflow | `README.md` |
| Commands and runtime dependency versions | `package.json` and lockfiles |
| Implemented behavior | Source code and passing tests |

## Maintenance contract

Update this file in the same change when any of these change:

- a product boundary or durable rule;
- storage, backup, migration, credential, or portability behavior;
- a capability becomes genuinely verified or a stated limitation is resolved;
- external prerequisites or the new-computer handoff;
- which document is authoritative for a topic.

Keep status claims evidence-based and concise. Move stable domain language to `CONTEXT.md`, detailed designs to the relevant plan, and hard-to-reverse implementation trade-offs to an ADR only when they warrant one.
