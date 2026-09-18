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
