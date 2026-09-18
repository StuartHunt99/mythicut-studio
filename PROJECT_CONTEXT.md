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
- Reuse verified timing and preview work when identity matches.
- The small two-clip Premiere XML fixture has user-confirmed import correctness. This does not establish full-recording, mixed-rate, or camera-rollover correctness.

### Image catalog

- Create, open, remember, and transaction-safely save a catalog to a chosen location.
- Add and scan multiple source roots without modifying images.
- Configure tag schemas and hosted providers, run tagging batches, and accept, edit, or undo tag reviews.
- Reopen a portable catalog on another operating system without migration checksum failures caused only by LF/CRLF conversion.
- Relocate a source root after a drive-name, mount-point, or drive-letter change while preserving image and tag identity.

Run the tests rather than trusting counts recorded in documentation. `package.json` is authoritative for current commands and runtime versions.

## Known limits and open work

- The auto-edit full-processing performance gate is not yet established.
- Mixed frame rates, variable frame rates, nonzero stream starts, and uncertain camera rollover joins require explicit verification before being presented as supported.
- Automatic selection and timing remain review aids; uncertain boundaries must stay visible and editable.
- The image-catalog architecture document describes later retrieval, embedding, batching, and hardening goals that may exceed the implemented slice. Verify against code and tests.
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
