# MythiCut Studio — MVP implementation plan

Status: implementation underway. The corrected opening sample has user listening approval; M1 project import/save foundation and background transcription with persisted candidate evidence are implemented. Automatic take recommendation remains pending. Remaining M0 integration checks are tracked in FEASIBILITY_STATUS.md.

Date: 2026-09-12. Working product name follows the project folder and original brief: **MythiCut Studio**.

## 1. Intended result

Import sequential talking-head recordings and an English script, propose the latest complete takes, review and edit the selection through text and continuous playback, then export an editable Adobe Premiere sequence referencing original media.

The initial acceptance environment is the user's 2019 MacBook Pro running macOS Sequoia and their installed Premiere version. Record exact hardware, RAM, OS, Premiere version, and media properties during the first implementation milestone. Do not assume Apple Silicon or NVIDIA acceleration.

Processing time divided by total source duration must be **less than 2.0** on the acceptance recording. Timing runs from starting analysis until the full proposed edit is available for continuous playback. Include extraction, transcription, timing refinement, matching, local LLM review, and preview generation. Exclude initial model downloads and human review. This is a release requirement, not a performance claim already demonstrated.

## 2. Accepted product behavior

### Import and script

- Import numbered media files in natural numeric order, with an order confirmation before analysis. Preserve original files in place.
- Typical sources are 4K ProRes or H.264. Probe actual streams rather than trusting file extensions.
- Import UTF-8 text or pasted text. Preserve the original script, paragraphs, and character offsets.
- Everything within square brackets is nonspoken, including multiline annotations. Brackets do not execute commands. Flag malformed/unclosed brackets before analysis; never silently discard the remaining document.
- Select audio channel 1 by default; allow per-file audition and selection. Flag missing or effectively silent audio.
- Permit an optional, configurable restart phrase. Recognize it as a standalone utterance; omit it and use the following speech to identify the restart position.

### Selection

- Recordings progress through the script, sometimes jumping backward and continuing forward. No general out-of-order assembly is required.
- Track sentences and the passages associated with restarts. Prefer the latest complete corresponding take. Minor word variation is acceptable; 90% similarity is guidance, not a cutoff.
- Do not judge factual correctness, semantic correctness, or delivery quality. Use linguistic context only to identify correspondence, completion, markers, and uncertain speech.
- Do not automatically stitch fragments from separate takes. Complete sentences from different attempts may be combined.
- If a later reading skips a previously recorded sentence and continues past it, propose omitting that sentence and flag its previous occurrence.
- If a final restart is abandoned, recover the earlier complete ending and flag the handoff.
- Leave genuinely unrecorded script passages absent. Never synthesize or reconstruct them from unrelated footage.
- Remove recognized restart markers and obvious abandoned attempts. Preserve uncertain complete additions with a review flag.

### Camera file joins

Numbering establishes order, not continuity. Infer continuity when a word spans adjacent files or the transcript forms an exact script continuation across the join. Review uncertain evidence with the local LLM.

At an accepted join, automatically assemble both source pieces without trimming, padding, or applying pause removal at the join. A sentence spanning such a join is one take, not prohibited fragment stitching. Exact script continuation is an editorial inference, not proof of physical recording continuity. Show the inferred join in review and allow reversal. Do not invent missing audio or automatically remove apparent duplicated camera frames.

### Timing and review

- Default maximum pause target is 0.5 seconds total: up to 0.25 seconds of available quiet source footage on either side of an edit. Make the total configurable.
- If clean padding is shorter, use what exists. Never include rejected speech to satisfy padding and never insert an empty timeline gap.
- Shorten pauses longer than the configured maximum between sentences, including within a good passage. Preserve pauses within sentences and protected camera joins.
- Round starts earlier and ends later to actual video-frame boundaries. Preserve speech over the pause cap; permit the small excess caused by rounding.
- Allow word-level manual keep/delete, restoring alternatives, undo, text seeking, and continuous proposed-cut playback. No transcript typo editor is required. Direct time-boundary adjustment is a bonus.

### Persistence and export

- Save/reopen projects and autosave manual selections. Freeze script, media order, and channel choices after analysis begins; input changes require a new MVP project.
- Export Final Cut Pro 7 XML for Premiere, not modern FCPXML. Adobe explicitly documents the incompatibility of direct FCPXML import. [Adobe import documentation](https://helpx.adobe.com/premiere/desktop/organize-media/import-files/migrate-from-final-cut-pro-x.html), [Adobe FCP7 export documentation](https://helpx.adobe.com/premiere/desktop/render-and-export/export-files/export-a-project-as-a-final-cut-pro-xml-file.html).
- Default sequence: 1920×1080, first source's frame rate, scale to fill. Dimensions and sequence frame rate are configurable. Show mixed frame rates/aspect ratios before export.
- Reference original video and selected original-quality mono audio; link them and maintain synchronization. The 16 kHz analysis audio is never an export source.
- Editorial warnings do not block export. Invalid clip ranges or unavailable required source media do.

## 3. Technical direction

These are architecture decisions for implementation, with runtime/model versions pinned only after the feasibility checks.

| Responsibility | Proposed implementation | Reason and qualification |
| --- | --- | --- |
| Desktop and GUI | Electron, React, TypeScript | A single application language and a controlled browser playback environment. Keep filesystem and process access outside the renderer. |
| Background orchestration | TypeScript in an Electron utility process | Keeps analysis and parsing off the GUI thread; native tools run as supervised subprocesses. Electron documents this process model. [Documentation](https://www.electronjs.org/docs/latest/tutorial/process-model) |
| Media operations | FFmpeg and ffprobe | Inspect media, extract analysis audio, generate timing-preserving preview media, and render edited preview intervals. Validate the exact commands against fixtures. |
| Transcription | whisper.cpp, initial CPU-capable candidate | The project documents CPU inference and Intel macOS support. Benchmark model size and timing accuracy; do not equate timestamp precision with accuracy. [Project documentation](https://github.com/ggml-org/whisper.cpp) |
| Local language model | llama.cpp with a compatible quantized instruct model | Start with a locally supervised runtime rather than a mandatory cloud account. Select model size, context, and quantization using the target machine and examples. CPU implementations are documented upstream. [Project documentation](https://github.com/ggml-org/llama.cpp) |
| Project state | Versioned JSON with atomic replacement | Adequate for one local project and avoids adding a database runtime before an artwork catalog exists. Keep large analysis artifacts separate from frequently saved review state. |
| Tests | TypeScript test runner plus real-media fixtures | Verify behavior through module interfaces, with actual Premiere import as an integration gate. |

Do not add Python, Tauri, a hosted backend, or a generic provider framework by default. Introduce another runtime only if the timing feasibility check demonstrates a need that the selected tools cannot meet.

## 4. Modules and interfaces

Use a small number of deep modules. Keep storage and process details inside their implementations.

| Module | Interface and responsibility | Must not own |
| --- | --- | --- |
| Project | Create/open a project, persist review commands, load artifacts, report input changes | Editorial inference or media rendering |
| Media | Probe sources, extract analysis audio, map frame/sample time, inspect joins, prepare/render previews | Script matching or take preference |
| Analysis | Analyze immutable inputs; return timed evidence, matches, attempts, recommendations, warnings | GUI mutation or export XML |
| Review | Apply validated user commands to a proposal; produce a versioned selection | Rewriting the original transcript or invoking models |
| Timeline | Compile a selection and timing policy into validated source intervals and sequence placements | LLM calls or independent editorial decisions |
| Premiere export | Serialize a compiled timeline and media metadata as FCP7 XML | Choosing takes, padding, or independent time rounding |

The GUI calls typed commands through a narrow preload interface. No arbitrary shell execution or filesystem access from React. Job events include job ID, stage, progress when measurable, cancellation state, and recoverable error details.

Preview and XML export consume the **same compiled timeline revision**. Manual edits create a new revision. An older preview cannot be displayed as if it represents the new one.

Local inference and manual ChatGPT packet import share the same validated recommendation data contract. This is a real seam with two input paths; a cloud provider implementation is deferred.

## 5. Data contracts

Every artifact has a schema version and project/input identity. IDs are immutable within the project and are not based solely on displayed text, since sentences can repeat.

| Record | Required information |
| --- | --- |
| MediaAsset | ID, file URI, ordered position, file identity, stream indexes, channel mapping, dimensions, rotation, pixel aspect ratio, frame-rate rational, stream time bases, start offsets, duration |
| ScriptSentence | ID, paragraph ID, source character span, original text, matching tokens; preserve annotation spans separately |
| TranscriptWord | ID, actual recognized text, one or more source spans, timing reliability, optional recognizer confidence, speech segment ID |
| SourceSpan | Media ID, stream-relative start/end, frame/sample mapping references; interval convention is start-inclusive/end-exclusive |
| FileJoin | Left/right asset IDs, evidence, automatic/LLM/manual disposition, protected status, warning reason |
| SentenceCandidate | ID, transcript word IDs, source spans, candidate script IDs, completeness status, attempt ID, matching evidence |
| Attempt | ID, chronological order, entry/exit script positions, candidate IDs, completion or abandonment evidence |
| Recommendation | Case ID, existing candidate IDs, proposed selection/classification, short rationale, local/manual origin, model/prompt version |
| ReviewState | Proposal identity, manual commands, undo/redo cursor, unresolved flags, revision number |
| CompiledTimeline | Revision, sequence settings, ordered source intervals, linked audio placements, frame positions, word-to-sequence mapping, validation warnings |

Persist rational media times as integer numerator/denominator pairs; use decimal strings for values that could exceed safe JavaScript integers. Keep transcript estimates separate from quantized edit times. Never repeatedly add floating-point seconds to place clips.

Maintain three explicit coordinate systems: original file/stream time, analysis time, and output sequence time. Preserve mappings through resampling and proxies. For a word spanning files, use multiple source spans, not a fictitious timestamp beyond the first file.

Core invariants:

1. All references resolve and all source intervals fall within available media.
2. Sequence placements are contiguous and positive-duration, with linked audio covering the same intended elapsed time.
3. No automatic sentence uses fragments from unrelated attempts.
4. Protected camera joins preserve both original file edges exactly.
5. Padding never consumes known rejected speech; overlapping retained padding is coalesced, not duplicated.
6. Manual review overrides automatic recommendations and remains intact across playback rebuilds.
7. Preview and export identify the same compiled revision.
8. Unrecognized or stale LLM identifiers cannot create timeline intervals.

## 6. Analysis and edit algorithm

### A. Prepare evidence

Probe files, confirm order and channels, snapshot the script, and parse annotations. Extract selected-channel analysis audio with explicit source-time mappings. Transcribe actual speech; do not force the whole script onto the recording, because omissions and repetitions would create misleading alignments.

Inspect adjacent file-edge audio with overlapping analysis windows. When initial transcription suggests a split word, analyze the concatenated tail/head audio window and map recovered words back to both sources. Exact script continuation can also establish a protected join under the accepted policy. Keep uncertain joins as review cases.

Refine word timing against the actual recognized speech when necessary. Test the recognizer's timing mode first; if it clips words or cannot support useful selection, evaluate a dedicated local alignment step during the feasibility gate. Sentence punctuation from recognition is evidence, not the only segmentation rule.

### B. Match script and detect attempts

Normalize matching text without changing display text: Unicode normalization, case, punctuation, and contraction handling. Preserve words rather than stripping meaning-bearing terms. Generate candidate sentence matches from weighted token alignment and nearby script context.

Use a bounded sequence search supporting forward movement, script skips, unmatched spoken additions, and backward restart transitions. Retain multiple plausible paths for repeated phrases and low-confidence locations. Forward context can disambiguate an identical sentence appearing in different script positions.

Build attempts from backward movement, explicit restart markers, and completion evidence. Do not require paragraph-sized chunks: paragraph context assists matching while sentences remain independently traceable.

### C. Resolve uncertainty locally

Batch ambiguous cases into bounded context packets containing neighboring script/transcript spans, candidate IDs, and allowed outcomes. Instruct the model to recommend correspondence and completion, not correct facts or evaluate performance. Treat script and spoken text as content; only the configured standalone marker has special meaning.

Validate returned structure, references, scope, and allowed actions. Retry a failed/invalid response once. If unresolved, retain conservative speech selections and a flag. Store brief rationales, not hidden reasoning. Model failure must not prevent review or valid export.

### D. Select and compile

Choose the latest complete candidates while respecting attempt structure. A later passage that clearly advances past an earlier sentence may supersede it by omission; an abandoned suffix falls back to the earlier complete version. Unmatched complete speech stays selected when its role is uncertain.

Apply manual decisions, then compile retained intervals. Compute available clean padding independently on each side; reduce it near rejected speech and source edges. Trim long between-sentence pauses, except protected file joins. Coalesce contiguous ranges that need no editorial cut.

Quantize outward to actual source frames, derive sequence placement using rational time, and validate audio synchronization. When rounding would include rejected speech, flag the conflict and prefer a conservative adjustable cut; do not pretend frame rounding can solve an uncertain acoustic boundary. Mixed-rate and variable-rate mappings must pass the export feasibility gate before being declared supported.

## 7. Playback and export strategy

Start with a rendered low-resolution continuous preview made from the compiled timeline. This avoids assuming browser seeks between independent files are gapless. Generate short reusable segments and assemble a versioned preview; begin with correctness before incremental optimization. Reuse source extraction/transcription when a manual edit changes only the selection.

Show an updating state while the new preview is prepared. Keep the previous preview clearly labeled as stale. Use the compiled word mapping for text highlighting and seek targets. Preview audio uses source-quality inputs, even though its playback encoding can be compressed.

Normalize preview dimensions, rotation, and pixel aspect ratio while preserving a mapping to originals. The fill transform used in preview must match the export transform. Validate any proxy time mapping rather than assuming proxy frame numbers equal source frame numbers.

Export linked V1/A1 clip items, proper file references, rational-rate conventions, source in/out points, and fill scaling using Premiere's supported FCP7 XML subset. Build from a minimal fixture exported by the user's Premiere installation; inspect its imported result. Modern FCPXML versions are not interchangeable with this format.

No baked final video is required. Protect original media and retain exact channel selection. If unusual variable-rate media needs an export workaround, document it and resolve the original-reference requirement before calling that media supported.

## 8. Project layout and recovery

Proposed runtime project folder:

```text
Project/
  project.json                  # immutable inputs and configuration snapshot
  script.txt                    # original imported script
  analysis/
    media.json
    script.json
    transcript.json
    matches.json
    recommendations.json
  review.json                   # commands, selections, revision, undo state
  cache/                        # regenerable analysis audio and previews
  exports/
    premiere.xml
    review-packet.md
    review-response.schema.json
  diagnostics/
    jobs.jsonl
```

Save through same-directory temporary files and atomic replacement, retaining a last-good review snapshot. Detect interrupted writes and stale preview revisions on reopen. Checkpoint completed expensive stages. Cancellation stops subprocesses and retains valid completed artifacts. Source disappearance is actionable; block affected export without discarding review decisions. Full relinking and revision merging remain deferred.

The manual ChatGPT packet contains readable script/transcript context, stable IDs, permitted recommendation actions, schema, and project/analysis identity. Import its JSON answer as a proposal after validating identity and scope. Reject unknown IDs and stale packets; do not let returned text specify paths, commands, or timestamps. No OpenAI integration or account setup is needed for this workflow.

## 9. Implementation milestones and exit gates

| Milestone | Work | Required evidence before advancing |
| --- | --- | --- |
| M0 — Feasibility | Inspect target machine; obtain representative script/media and camera rollover sample; benchmark transcription/timing and local model candidates; build a minimal preview and XML import experiment | Actual Premiere import preserves linked audio, cuts, source refs, and fill; rollover words remain intact; selected local configuration has measured performance. Run an early full-length budget check, not only a short extrapolation. |
| M1 — Project and media foundation | Desktop shell, import, channels, script parsing, time mappings, schema validation, save/reopen, job progress/cancel | Fixtures import reproducibly; malformed brackets and bad audio are visible; saved project survives reopening and interrupted work. |
| M2 — Analysis and recommendation | Word evidence, joins, contextual matching, attempts, omission/recovery rules, local review | Expected candidate selections and flags on all editorial fixtures; malformed/model-failure responses degrade safely. |
| M3 — Timeline and Premiere export | Pure timeline compilation, padding, rounding, channel linkage, XML serialization | Timing invariants pass; real Premiere import matches expected source and sequence positions with no drift. |
| M4 — Text review and continuous playback | Word selection, restore, undo, synchronized text, preview compilation and revision management | Manual changes survive reopening; continuous playback matches the exported revision, including joins and long-pause edits. |
| M5 — Backup workflow and release verification | Markdown/JSON round trip, diagnostics, packaging for target Mac, full benchmark and acceptance review | User-reviewed representative cut passes; cold project processing ratio <2.0; app launches with pinned local dependencies and no development environment requirement. |

M0 validates the riskiest assumptions before substantial GUI work. M1–M5 use its selected runtime versions and media mappings. Do not start artwork work to fill time while an MVP gate is failing.

No calendar estimate is asserted before representative media and the first benchmark exist. The supplied Susan recording exercises transcription, acoustic alignment, preview rendering, and project import. Remaining M0 checks (Premiere import, real rollover footage, full-pipeline benchmark) remain open while the user-authorized M1 foundation proceeds.

## 10. Acceptance cases

| Case | Expected result |
| --- | --- |
| Clean sequential reading | Complete dialogue preserved; only long between-sentence pauses shortened |
| Paragraph restart | Latest complete sentences retained without duplicate earlier passage |
| Earlier A B C D; later A′ C′ D′ E | Earlier B proposed omitted and flagged |
| Earlier A–F; later C′ D′ abandoned E′ | A B C′ D′ E F with a flagged recovered ending |
| Similar wording, changed fact or negation | Correspondence may be recognized; no factual correction policy imposed |
| Uncertain complete ad-lib | Retained with review flag |
| Recognized standalone restart phrase | Phrase excluded; matching resumes based on following speech |
| Repeated phrase at two script positions | Context resolves it or uncertainty remains visible |
| Word split across camera files | One logical word/sentence, exact original file-edge join preserved |
| Numbered files separated by a deliberate stop | No continuity inferred solely from filenames |
| Insufficient quiet padding | Shorter pause, no rejected word added and no empty gap |
| Multiline or malformed brackets | Valid notes excluded; malformed input reported before silent loss |
| Word-level manual removal and undo | Selection and playback change together; restoration survives save/reopen |
| Invalid or unavailable model | One retry then conservative, usable project with flags |
| Stale ChatGPT response | Rejected without changing reviewed selections |
| Mixed rates, source offsets, selected channel | Correct mapped timing and audio in preview and Premiere; unsupported cases explicitly identified |

Use synthetic known-timing clips to test frame/sample mappings and real speech to assess clipped phonemes. XML schema validity alone is insufficient. Listen around every cut in the curated acceptance recording and compare representative Premiere clip positions to the compiled timeline.

Report total elapsed time and per-stage timings, model/runtime versions, media duration, peak memory, and cache state. Release timing must use a fresh project cache, while permitting installed model files. Full continuous preview readiness ends the timer. Report correction count and unresolved cases separately; no invented universal accuracy percentage is a release substitute.

## 11. Future work and maintained seams

Deferred: Windows release, Google Docs integration, cloud inference, input revision merging, media relinking workflow, freeform spoken instructions, performance-quality judging, artwork catalog, B-roll selection, motion, and Resolve-specific export.

Keep the compiled timeline independent of the matching implementation so a future LLM-led selection strategy can replace current matching without replacing review, timing validation, preview, or export. Keep sequence layers representable without building a generic multi-track editor now. Add artwork storage and schema design when that phase begins.

## 12. Completion definition for this planning task

The agreed requirements, proposed architecture, data formats, algorithms, sequencing, and validation gates are recorded here. Implementation and hardware/media verification are the next task; no dependencies, models, or app code have been installed or generated as part of planning.
