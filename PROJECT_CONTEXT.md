# MythiCut Studio project context

This is the short, maintained handoff for humans and coding agents. It records current boundaries, durable decisions, portability requirements, and where to verify details. Plans remain useful, but a plan item is not implemented merely because it is documented.

## Product boundary

MythiCut Studio is a local-first Electron application with two separate workflows:

1. **Auto-edit** imports ordered talking-head recordings and a script, builds recognition and matching evidence, lets the user control a word-level reviewed selection, previews that selection, and exports Final Cut Pro 7 XML for Adobe Premiere.
2. **Image catalog** scans user-selected artwork folders, proposes structured tags through a configured hosted provider, records human-reviewed tags, and exposes accepted metadata for later retrieval.

The workflows share one desktop window with Edit, Tag, and B-Roll workspace tabs and a tool-specific configuration panel. They do not share a persistence model: auto-edit projects use versioned JSON plus adjacent analysis artifacts, while image catalogs use independent SQLite files.

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

- The desktop shell opens one fixed-height, three-tab workspace. Edit has source and synchronized transcript panels, B-Roll has pipeline state and a scrollable decision grid, and Tag retains its scrollable catalog grid. Navigation preserves each workflow's main-process state while renderer views reload. Prompts, edit timing preferences, provider settings, schema, and motion rates are reached through configuration rather than occupying the review workspace. The page itself does not scroll; internal panes do. The prior long review instructions were removed. Isolated Electron checks passed tab switching, configuration access, and no-page-scroll for all three tabs, including a read-only Jadis project load; live user interaction on the redesigned production workspace remains to be checked.
- The B-Roll workspace no longer enforces a broad page minimum width: its pipeline rail narrows, action groups and review-header buttons wrap, and beat preview/controls stack when the stage is narrow. An isolated 820-pixel Electron layout check with a test-only review card confirmed the right-hand header and override buttons fit without horizontal card overflow; real artwork review at the user's display scaling still needs visual confirmation.
- Create, save, reopen, and analyze an auto-edit project.
- Preserve the original script, ordered recording inputs, recognition evidence, manual word selections, and undo/redo history.
- Audition original source video separately from edited playback.
- Compile the reviewed selection for preview and FCP7 XML export.
- Lock the current reviewed edit as an immutable, fingerprinted phase-1 transcript handoff with retained word IDs, original or marked provisional source-time spans, sequence-frame placements derived from the exported compiled intervals, and sentence/paragraph context. The active handoff is referenced from the project; older handoffs remain adjacent and unchanged. A separate evaluation-only importer accepts source transcription words plus the same compiled edit intervals, never timings inferred from a baked video.
- Zero-duration interior Whisper words can receive provisional source-time spans apportioned between the nearest usable words in the same recording (up to a 2.5-second gap). Raw recognition timestamps and review choices stay untouched; the derived spans remain marked for review and are locked with phase 1. Words without safe neighbors still block locking. Optional acoustic refinement can replace the provisional spans with supported timing.
- Reuse verified timing and preview work when identity matches.
- On this Windows workspace, phase-1 media prerequisites can live in ignored `.local/tools/ffmpeg/bin`, `.local/tools/whisper`, and `.local/models/ggml-base.en.bin`. The Electron launcher and analysis CLI prepend the local tool directories to PATH when present; a new computer still needs its own binaries and model. The current local copies were downloaded from the FFmpeg-linked Windows essentials build and official whisper.cpp release/model sources and digest-checked. This setup has not yet established transcript accuracy for the user's reference video.
- Optional acoustic timing refinement uses `.local/align-env/Scripts/python.exe` on Windows and `.local/align-env/bin/python` on macOS/Linux. This Windows workspace has a local Python 3.12 environment with the pinned alignment dependencies and Wav2Vec2 model. These ignored dependencies are not carried by Git; the full Windows acoustic refinement run has not been verified.
- The user's saved Jadis phase-1 selection was checked read-only on Windows: all 1,609 retained words lock into four compiled clips, with 12 zero-duration words given provisional neighbor spans. No production project or analysis artifact was rewritten in this check.
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
- Use a separate `search.broll` catalog command for the phase-2 search contract: bookless all-accepted retrieval, soft character signals, eight results by default, strict embedding readiness, and a configurable half-output-resolution gate. Full local results retain current image/version and detection data; the selection packet includes filenames without paths or detection coordinates. The existing `search.hybrid` demo keeps its required-book and hard-character behavior.
- Query `search.broll.readiness` before a hosted beat-planning call to verify the full accepted-image pool and local embedding model are ready, without spending hosted-model tokens on a partial catalog.
- Edit and restore all hosted-task prompt defaults in the catalog or auto-edit project settings. Tagging/detection prompts are stored with the provider profile and snapshotted when a run starts; B-roll prompt overrides are stored in the auto-edit project. Structured output and locked timing validation remain enforced independently of prompt wording.

### B-roll planning (integration not yet interactively verified)

- The project screen offers an explicit “Plan B-roll beats” action using the current locked handoff, the remembered active image catalog, its hosted provider profile, and its machine-local encrypted credential. A utility worker runs the planner; the project references a fingerprinted adjacent `.broll-plans` artifact. The artifact keeps catalog/image IDs, accepted revisions, filenames, and cached candidates, but not artwork filesystem paths. It must travel with the project when moved or backed up. Old plans remain unchanged when the reviewed edit is relocked or prompts change.
- The structured text-agent planner validates a complete ordered partition of locked word IDs and never retimes phase-1 words. Its hosted request contains only compact sentence-grouped transcript words with short local IDs, a brief video context, and nearby text—no frames, timestamps, media identity, paragraph payload, or catalog vocabulary. Real word IDs and timing are restored locally; image search receives the resulting semantic query afterward. It marks opening and closing passage windows, flags the wardrobe-establishing and direct-address passages, and searches viable artwork beats once. Hosted response and candidate behavior are verified with mock providers and catalogs; no successful production hosted plan has been made.
- Beat planning preserves the LLM's validated word ranges exactly: no procedural short-beat merge or long-beat split. The per-project B-Roll artwork configuration now defaults to a four-second minimum clip (editable from three to fifteen seconds) and snapshots that number in each new immutable beat plan. Artwork beats below the plan's minimum remain visible with a warning but are not searched; coverage warnings and manual override eligibility use the same saved minimum. Legacy plans without a snapshot retain their original five-second rule. Changing configuration does not alter saved plans or recover skipped candidates; the user must explicitly replan through the configured hosted provider. Spanning one still across related semantic beats remains future work.
- The project screen also has an explicit image-selection action for a current beat plan. Initial choices and sparse allocation updates are saved separately in a fingerprinted adjacent `.broll-selections` artifact; that folder must travel with the project. The selection agent receives only path-free packets, and duplicate safety can leave a beat blank. A cheap perceptual hash is computed only for chosen candidate images to flag likely near duplicates; these are warnings, not forced replacements. Coverage, long uncovered gaps, missing required artwork, and closing-montage image count are reported independently. One image per beat is supported now; multi-image beat groupings remain future work. This is mock-tested core behavior, not a verified production selection or review UI.
- A separate motion action and configurable rate/safety settings produce a fingerprinted adjacent `.broll-motions` artifact, which also travels with the project. A hosted text agent chooses direction, speed, and a local detection anchor (or center); deterministic geometry computes centered fill-frame zoom endpoints and pan crops. Zoom out starts on an anchored close crop and ends on the centered full-frame crop. Exceeding preferred scale, subject margin, or effective-detail limits records warnings while preserving feasible motion; only geometrically impossible motion falls back to static. Older safety-fallback decisions are recalculated locally for review/export without changing their fingerprinted artifacts. Geometry and provider interaction are unit-tested, not verified in a live project or Premiere.
- **Recalculate crops · no AI** is now available directly in the B-Roll toolbar for an existing motion plan, as well as **Apply to current motion** in configuration. Saving a manual image override already computes fill-frame geometry for that new image. When saved motion rates change, local recalculation creates a fingerprinted base-motion artifact and sparse recalculated copies of manual override layers without changing image choices, directions, anchors, or locked word timing. If images and rates already match, the action is a no-op. Tag/schema/catalog revision changes alone do not require beat replanning or affect geometry. The separate **AI plan motion** action only checks current selected image identity, activity, and file availability against the same catalog, not its global revision; it remains a hosted-model run. Core tests and a read-only Jadis-plan recalculation passed; the new toolbar interaction still needs live verification.
- M6 has a combined scrollable review UI backed by the accepted-image catalog. It shows each beat's text and blue bookending context, one centered fill-frame preview with detection, anchor, and keyframe overlays, plus clickable thumbnails for the other candidate images. The image stays at the full-frame crop while the zoom-in final or zoom-out initial crop is drawn at its actual smaller size. Unsafe margins or scale outline the main preview in red. Clicking a candidate, changing motion direction/speed, choosing a detection-box anchor, or resetting to center now saves immediately; there is no per-beat Save override button or anchor dropdown. Image changes append a sparse layer, while repeated motion edits to the same image update its current layer to avoid excessive Premiere tracks. The review resolves current catalog paths on demand and checks artwork existence before accepting a choice. Core state/geometry/persistence tests pass; the revised Electron interactions still need live verification.
- Review also supports Merge ↑/↓ for adjacent beats as project-saved grouping decisions over immutable beat-plan artifacts. The neighboring target keeps its effective image and motion intent; the clicked donor loses its image assignment while its text, locked interval, and cached candidate suggestions join the target. Merged artwork motion is procedurally recalculated for the full range, with no word retiming or hosted-model call. The grouping survives project reopen and local/AI motion replanning within the same beat/image plan; old groups become inactive when those plans change. Core tests cover repeated merges, candidate union, export intervals, and motion recalculation. Live UI and Premiere import remain unverified.
- A saved beat whose selected artwork is no longer usable now has a red card border and red unavailable-image placeholder; a late image-load failure also turns its preview red. This distinguishes an export-blocking image problem from the amber no-artwork placeholder and from red unsafe-motion crop outlines. The styling has syntax/test checks but still needs live visual confirmation after the app restarts.
- Each B-Roll review card offers **AI Search**: its compact modal prefills the semantic query and tag assumptions, has collapsible editable filters and a user-settable result count from 1 to 50 (default eight), and queries the same local `search.broll` hybrid index without a hosted-model call. Choosing a result appends a sparse manual override, including a path-free snapshot when the image was outside the immutable initial candidates; review and export resolve its current path/version from the catalog. The saved artwork minimum still applies. The user has reported that initial manual search worked; the revised layout/count control still needs live UI verification.
- Pencil controls on the selected preview, small candidate thumbnails, and manual search results open an editor for current accepted tags and an image-deactivation checkbox. The user confirmed live editing and deactivation in B-Roll review. Saving is an audited, optimistic-concurrency-checked catalog transaction: edits create an accepted tag revision, deactivation retains the file, metadata, and history but removes the image from future retrieval, and the project does not store a second copy of tags. No catalog migration is needed. A tag-only revision does not invalidate an already-reviewed selection of the same unchanged image version; replacement, deactivation, missing media, or loss of acceptance still blocks use/export. Tag edits make the embedding index stale. Beat/search planning retains strict all-image readiness; the manual review search can continue over currently indexed images and reports how many revised images are temporarily omitted until Update Embeddings.
- M7 has a shared B-roll timeline compiler and an explicit Premiere XML export in the combined review. It appends direct still clips on a base artwork track and sparse override tracks above the unchanged phase-1 video/audio XML, using stored crop geometry for editable Basic Motion keyframes and hard cuts. The review displays an export track/clip preflight from this same compiler. Export checks the locked handoff, current catalog image version/active acceptance, resolved file existence, and original source-media identities, and writes atomically; a tag-only accepted-revision change no longer invalidates the same image file. Unit tests cover phase-1 audio preservation, sparse stacking, cleared artwork, stale input rejection, and crop/keyframe mapping. Premiere import and visually correct motion endpoints are not yet verified.
- Export preflight now validates the final visible artwork for each beat and reports its filename and specific eligibility failure. A deactivated, missing, or stale lower-track image that is fully superseded by a valid saved override is omitted from exported XML without deleting its project-history decision; valid older layers remain stacked. A final visible image that fails eligibility still blocks export, and a clear removes all lower artwork for that beat. This is covered by timeline/XML tests; the user's live Jadis review and a fresh Premiere import still need checking after selecting any replacement artwork.
- Phase-1 and B-roll FCP7 XML now serialize Windows drive media as `file://localhost/D%3A/...`-style local URLs for Premiere interchange, while keeping project/catalog filesystem paths unchanged. A Windows test checks both video and artwork paths round-trip without an unintended UNC prefix. This correction still needs a fresh Premiere import to confirm its relinking behavior; prior XML files retain their old URLs.
- The review's export preflight passes the accepted tag revision ID through to the timeline compiler. Omitting that ID previously made current, usable artwork look stale and disabled the XML export button. The saved Jadis review preflight is checked against its current catalog and original media without writing an XML; Premiere import remains a manual check.

Run the tests rather than trusting counts recorded in documentation. `package.json` is authoritative for current commands and runtime versions.

## Known limits and open work

- The auto-edit full-processing performance gate is not yet established.
- Mixed frame rates, variable frame rates, nonzero stream starts, and uncertain camera rollover joins require explicit verification before being presented as supported.
- Automatic selection and timing remain review aids; uncertain boundaries must stay visible and editable.
- The image-catalog architecture document marks the implemented retrieval slice explicitly. The in-app retrieval demo is for manual inspection rather than downstream selection; a formal relevance/latency benchmark, packaged model delivery, and broader release hardening remain deferred.
- `BROLL_PIPELINE_PLAN.md` defines the locked-edit-to-artwork-to-motion integration. M1 handoff and M2 B-roll search contract are implemented and covered by tests, but not yet exercised against the user's production reference edit/catalog. The whole-script context line is extractive, not a hosted-model semantic summary. M3–M5 have app actions and tested cores but no interactive or real hosted run; production editorial evaluation and comprehensive creative allocation remain. M6 review UI and M7 XML export are wired and unit-tested; interactive Electron review, production Premiere import/motion, catalog-root relocation, and M8 editorial comparison remain open.
- The first two live Jadis beat-planning attempts returned Gemini HTTP 400. A third schema-free attempt was accepted by Gemini, but the model echoed the schema instead of producing beats; the diagnostic showed a 36,623-byte request containing redundant timing, script-derived paragraph data, catalog vocabulary, and repeated schema text. A fourth live attempt proved that the redesigned 3.6–6.8 KB transcript-only chunks still received `INVALID_ARGUMENT` before generation, isolating the failure to the provider contract rather than transcript size. The provider grammar now omits nested strict-object and array-bound keywords that can trigger Gemini's structured-output complexity rejection; the application still strictly enforces 1–40 beats, required values, ordered real word IDs, and complete chunk coverage after generation. No script sentence/paragraph IDs or script-derived summary are used. The old saved default prompt is migrated only when it exactly matches the former shipped text; user-edited prompts remain untouched. The compatibility change is mock-tested and needs one user-initiated live retry. No paid request was made during this diagnosis.
- B-roll worker runs now write a per-attempt JSONL provider diagnostic beside the project in `<project>.broll-logs`, including safe request/response/error events and raw text from parse failures when the provider SDK exposes it. API credentials are never logged. The project error reports the log path; this is covered by provider serialization tests but not yet verified in a live worker run.
- Electron UI smoke commands, including the updated B-Roll workspace layout check, currently fail in this automated Windows environment because Chromium's GPU subprocess cannot start; the tagging check also failed with `--disable-gpu`. Node unit/integration and renderer syntax checks pass, but these new controls need a live user visual/interaction check.
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
