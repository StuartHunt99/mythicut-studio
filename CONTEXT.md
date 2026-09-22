# MythiCut Studio

MythiCut Studio has two related creative workflows: assembling a reviewed talking-head edit and maintaining a reusable tagged artwork collection. This glossary keeps their language distinct.

## Shared language

**MythiCut Studio**:
The desktop product containing the auto-edit and image-catalog workflows.

**Original media**:
User-owned recordings or artwork that MythiCut references without altering.
_Avoid_: Input files, assets when the media type matters

**Human review**:
An explicit user decision that accepts, changes, or rejects an automated suggestion.
_Avoid_: Validation, approval when no user decision occurred

## Auto-edit language

**Auto-edit project**:
A saved editing workspace for ordered recordings, one script, analysis evidence, review decisions, and export settings.
_Avoid_: Catalog, database

**Source recording**:
An original video file in the confirmed chronological recording order.
_Avoid_: Clip, footage file

**Script**:
The preserved written source against which recorded speech is matched; bracketed text is nonspoken annotation.

**Transcript word**:
A recognized spoken word with stable identity, source location, and timing evidence.
_Avoid_: Script word

**Sentence candidate**:
A possible correspondence between a script sentence and a span of recognized speech.
_Avoid_: Take, match

**Attempt**:
A chronological reading passage bounded by restart or completion evidence and containing sentence candidates.
_Avoid_: Recording, take

**Automatic suggestion**:
The initial set of transcript words proposed for the edit before human review.
_Avoid_: Final edit, approved selection

**Reviewed selection**:
The current user-controlled set of retained transcript words used for playback and export.
_Avoid_: Automatic suggestion, transcript

**Keeper**:
The retained source occurrence associated with a script passage.
_Avoid_: Candidate, take

**Compiled timeline**:
The ordered source intervals and sequence placements derived from one reviewed selection and its export settings.
_Avoid_: Preview, export

**Locked edit handoff**:
The immutable edited-transcript, word-timing, and compiled-timeline snapshot passed from phase 1 to B-roll planning.
_Avoid_: Raw script, source transcript

**Visual beat**:
A phrase- or clause-bounded span of retained edited speech used to decide whether and how artwork supports the narration.
_Avoid_: Source clip, sentence candidate

**B-roll plan**:
The project-specific artwork choices, motion decisions, and sparse overrides placed above the talking-head timeline.
_Avoid_: Image catalog, rendered video

**Beat plan**:
An immutable proposal of visual beats, artwork opportunities, and cached catalog search candidates tied to one locked edit handoff.
_Avoid_: Final image selection, retimed transcript

**Image selection**:
The provisional per-beat artwork choices plus sparse whole-video conflict replacements, tied to one beat plan.
_Avoid_: Accepted catalog tags, human review

**Motion plan**:
The provisional motion intents and deterministic frame-fill crop paths tied to one image selection.
_Avoid_: Baked animation, changed source image

**Source audition**:
Playback from an original recording around a selected passage, including speech outside the reviewed selection when present.
_Avoid_: Edited playback

**Edited playback**:
Continuous playback representing a compiled timeline.
_Avoid_: Source audition

## Image-catalog language

**Image catalog**:
A long-lived collection of referenced artwork, tagging definitions, tag history, and review decisions.
_Avoid_: Auto-edit project, image folder

**Source root**:
A user-selected folder that anchors relative locations for cataloged images.
_Avoid_: Drive, catalog

**Cataloged image**:
One stable artwork identity that may have multiple observed file versions and source-root memberships.
_Avoid_: Image file, image version

**Image version**:
One observed state of a cataloged image, distinguished by its file identity and inspection evidence.
_Avoid_: Cataloged image, revision

**Tag schema**:
The named definition of tag categories and their allowed vocabulary.
_Avoid_: Prompt, provider configuration

**Schema version**:
An immutable published structure of a tag schema.
_Avoid_: Tag revision

**Retired tag value**:
A vocabulary choice hidden from future tagging and retrieval controls while remaining valid and visible in accepted tags that already use it.
_Avoid_: Deleted tag, schema change

**Tag proposal**:
Provider-generated tag values awaiting human review.
_Avoid_: Accepted tags, final tags

**Accepted tags**:
The current human-reviewed tag values for an image version and schema version.
_Avoid_: Tag proposal

**Tag run**:
A durable batch of image-version tagging work under one schema, provider snapshot, and selection policy.
_Avoid_: Scan, review

**Scan**:
Reconciliation of a source root with the catalog’s known image identities and observed versions.
_Avoid_: Tag run, import

**Deactivated image**:
A cataloged image intentionally hidden from the normal review grid, embedding updates, and retrieval while its identity, metadata, detections, and history remain available for later reactivation.
_Avoid_: Deleted image, missing image

**Retrieval document**:
The deterministic human-readable text built from one image version’s current accepted metadata for lexical indexing and semantic embedding.
_Avoid_: Filename, prompt

**Embedding profile**:
The immutable local-model identity and encoding policy required to compare catalog and query vectors safely, including model revision, dimensions, pooling, normalization, and query instruction.
_Avoid_: Provider profile

**Hybrid image search**:
Accepted-image retrieval that can apply structured book constraints, combines FTS lexical rank with local semantic similarity, and adds bounded structured tag boosts. The search demo requires a book and hard-filters character; B-roll search can span all accepted artwork and treats character as a ranking signal.
_Avoid_: Tag filter, object detection

**Selection packet**:
The compact, path-free structured payload sent to the final-selection LLM, containing visual-beat context, eligible image IDs, human-readable accepted metadata, and retrieval ranking evidence.
_Avoid_: Search result, animation plan
