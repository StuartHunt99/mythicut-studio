# MythiCut Studio

MythiCut Studio is an Electron talking-head review editor under development. It imports recordings and scripts, suggests takes, saves word-level keep/remove edits, and auditions original footage. Continuous edited playback and Premiere XML use a shared timeline; the full Susan recording still needs acoustic timing refinement before those outputs can be generated.

See [the implementation plan](IMPLEMENTATION_PLAN.md) for the accepted behavior and milestones.

## Portable image catalogs

Run `npm run tagging` to open the image auto-tagger. Its catalog is a SQLite file containing image references, schemas, tags, reviews, and run history. Use **Save as…** to place a transaction-safe copy on an external drive; the app switches to that copy and remembers it for later launches. Use **Open catalog** on another computer to load it.

Artwork is linked by its path relative to each selected source folder. If the external drive has a different name, mount point, or drive letter on the new computer, click **Relocate** beside the unavailable source and select the same source folder on the drive. Image IDs, tag history, and accepted reviews are preserved; scan afterward to confirm current files.

API keys are deliberately not copied with a catalog. They stay encrypted for the local operating-system account, so enter the provider key once on the new computer.

## Run the current checks

Requires Node.js 22+ and FFmpeg/ffprobe on PATH. The media experiment and unit tests use Node built-ins. The desktop preview uses pinned Electron dependencies.

```sh
npm test
npm run feasibility
npm ci
npm run smoke
npm start
```

The second command creates synthetic source clips, a continuous preview, a shared timeline description, and FCP7 XML in `artifacts/m0/`. Re-running replaces only generated artifacts there.

Expected preview: blue with a 440 Hz tone for 2 seconds, then green with an 880 Hz tone for 1.5 seconds. Both tracks must join at exactly 2 seconds, with 105 video frames and 3.5 seconds of audio overall.

Import `artifacts/m0/premiere.xml` into Premiere to assess linked clips, source ranges, and synchronization. Automated XML checks are not a substitute for this import test. The sources use matching dimensions, so this experiment does not yet validate scaling to fill.

The Electron smoke check verifies media loading, duration, decoded blue/green frames, seeking, and playback progression. It saves `artifacts/m0/electron-smoke.json` and closes. `npm start` opens the preview for manual listening.

Remaining M0 work includes real rollover fixtures, reliable word-edge timing, broader local-model evaluation, variable-rate mappings, actual Premiere import/fill validation, and the full-pipeline time benchmark. The supplied recording has now exercised 4K and 24000/1001 preview timing; see the measured results below.

## Supplied recording

The first real-recording results are in [Feasibility Status](FEASIBILITY_STATUS.md). The [raw timestamped transcript](artifacts/sample/transcript-review.md) is available locally and is excluded from git.

The sample utilities operate on the prepared `artifacts/sample/` inputs:

```sh
node scripts/sample-analysis.mjs
node scripts/sample-preview.mjs
node scripts/transcribe.mjs AUDIO_PATH MODEL_PATH OUTPUT_PREFIX [DURATION_MS] [DTW_MODEL]
node scripts/export-word-transcript.mjs artifacts/sample/base-en.json artifacts/sample/base-en.words.json
```

`sample-analysis` generates diagnostic matching evidence and a local-model prompt packet, not final take selections. `sample-preview` generates two technical excerpts and XML at the supplied camera's 24000/1001 rate; it does not cut the whole recording. Word timing and Premiere import still require validation.

The transcription command requests Whisper's word-split output (`-sow`) and full token JSON. The companion word export reconstructs words from token-leading whitespace while preserving source offsets, probabilities, and DTW anchors. The SRT remains a readable review format; word-level editing should use `base-en.words.json`.

## Aligned sample edit

An approximately 48-second opening sample is now available at `artifacts/sample/edit/sample-edit.mp4`, with a matching `premiere.xml` referencing the original 4K source. The final opening passage is joined to the later complete question, and long between-sentence pauses are shortened. Selection is a curated test fixture; the full take-selection engine is still pending.

```sh
npm run sample:review
```

This opens Electron with playback, replay buttons for each join, and clickable transcript words. Dotted words have lower alignment confidence. Listening review and actual Premiere import are still required.

Reproduction after local alignment dependencies/models are present:

```sh
.local/align-env/bin/python scripts/align-sample.py
node scripts/audit-word-timing.mjs artifacts/sample/alignment/opening.json
npm run sample:build
npm run smoke -- --sample
```

The isolated alignment environment uses the pins in `requirements-alignment.txt` and the official torchaudio Wav2Vec2 base English model under `.local/models/`. This experiment is an additional local alignment stage; no cloud inference is used. The original Whisper transcript remains unchanged for comparison.


## Project import foundation

Run `npm run project` for the new project screen. Add recordings, confirm their order and channel, import or paste the script, and save a project JSON. Reopen with the Open button; the previous save is retained as a `.bak` file. Pasted script and preferences have explicit Apply buttons. Use Analyze / resume after saving.

The prepared source project can be opened directly:

```sh
npm run project -- --project-file artifacts/m1/Susan-project.json
npm run smoke -- --project
```

The corrected 50.43-second opening sample has user listening approval. Independent acoustic verification catches the two-to-one restart correction that Whisper alone missed. See `artifacts/sample/edit/restart-correction-review.md`.


## Saved-project analysis

The project screen now has **Analyze / resume**. Save and apply all inputs first. Analysis freezes inputs, extracts the selected channel, runs local Whisper, stores word evidence, and lists script-sentence candidates. A utility process keeps matching and transcription supervision outside the UI process. Cancel stops the current subprocess; completed source transcriptions are reusable on resume.

Development CLI:

```sh
npm run analyze -- artifacts/m1/Susan-project.json
npm run review:packet -- artifacts/m1/Susan-project.json
```

Results live next to the saved project in `<project-file>.analysis/<input-hash>/`: raw per-source JSON/TXT/SRT, a word-and-candidate `result.json`, readable `review.md`, and job/checkpoint records. Input/model identity controls reuse. Errors and cancellation are persisted in the project.

Candidate suggestions are initial editing suggestions. Exact word matches do not establish take completeness, and Whisper can omit repeated speech. The user reviews the highlighted transcript in the GUI; the current highlight state is the export selection. Word timing remains an estimate, and the user can correct any boundary by changing the highlighted words. The approved curated sample is separate from these new analysis results.

`review:packet` exports the flagged cases as JSON plus a readable Markdown file and a prompt for local or manual ChatGPT review. The packet contains stable case/candidate IDs and transcript text, but no timestamps or filesystem commands. Returned recommendations must pass the existing schema and ID validation before they can affect review state.


## Synchronized transcript review

Open the prepared project with:

```sh
npm run project -- --project-file artifacts/m1/Susan-project.json
```

The original script appears on the left, including formatting and bracketed notes. The full recording transcript appears on the right. Green marks the current export selection. Dotted gold underlines indicate uncertain timestamps. Blue underlines mark the original automatic suggestion and remain fixed while the user edits the green selection.

- The automatic suggestion starts highlighted and highlighted words are assumed approved for export. Drag anywhere across the recording transcript; the first word establishes the mode, so a highlighted first word removes the whole range and an unhighlighted first word keeps the whole range. The green state updates continuously while the pointer moves, including when a drag begins in inter-word whitespace. Single click toggles only that word. Double click applies the sentence rule: a uniform sentence flips as a whole, while a mixed sentence becomes uniform using the majority state.
- **Undo** and **Redo** include sentence decisions and word edits. Review changes autosave; reopening retains the selection and history. Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z, Delete/Backspace, and K work when focus is within the review surface.
- Click or scroll the script to jump to its keeper. Scrolling the recording alone does not move the script. The contextual take selector can restore an alternative or omit a sentence. Explicit word edits override sentence decisions until reset.
- Click a recording word, then **Play source** to audition a short original-video excerpt with the selected original audio channel. Source audition includes rejected speech and is labeled separately from edited playback.
- **Build edited playback** is optional and compiles the current selection. **Export reviewed selection to Premiere** uses the current highlighted state directly; a preview is not required. Every uninterrupted highlighted source run is one continuous clip, including pauses inside that run.
- **Refine word timing** runs local acoustic recognition and targeted alignment in a background worker. Completed evidence is cached; Cancel preserves completed work. The original transcript, word IDs, and manual selections remain intact. Unverified timing stays underlined. **Review this passage** jumps to a flagged cut and plays the source excerpt.

Short spoken additions such as “Now” remain inside their sentence instead of becoming script-driven deletions. Explicit restart markers, abandoned fragments, file boundaries, and substantial pauses limit edge expansion. Suggestions remain provisional: this heuristic is not the completed attempt/LLM recommendation engine.

The full Susan project has approximate word timings and four passages with less reliable boundaries. These are shown for awareness but do not block export; the highlighted selection remains authoritative. Fresh short-window recognition evidence and playable excerpts are in `artifacts/timing/conflicts/review.md`. The automatic opening matches all five source frame ranges of the previously approved 50.425375-second sample; independent recognition confirms one “Because today.” Mixed frame rates, nonzero stream starts, and camera rollover inference remain unsupported in this compiler slice.

Preview rebuilds reuse unchanged encoded segments, including when undo restores an earlier selection. Interrupted segments are discarded; preview and export still share a validated complete timeline. This reduces repeat work, but is not a completed full-pipeline performance benchmark.

Development timing commands (requires the local alignment environment described above):

```sh
node scripts/refine-project-timing.mjs artifacts/m1/Susan-project.json
node scripts/verify-refined-opening.mjs
node scripts/inspect-timing-conflicts.mjs
```

### Review verification

```sh
npm test
node scripts/verify-review-media.mjs
node scripts/verify-preview-cache.mjs
```

The media check uses the existing `artifacts/m0/first.mov` and `second.mov` fixtures; run `npm run feasibility` if absent. It verifies a 68-frame, 30 fps continuous preview, blue/green decoded frames, 440/880 Hz audio, and well-formed XML. The user separately confirmed the generated Premiere sequence is correct on September 13; acceptance is recorded in `artifacts/review/premiere-acceptance.json`. That acceptance does not establish mixed-rate or full-recording support. The cache check verifies unchanged segments, undo reuse, and recovery after interrupted encoding with actual FFmpeg renders.

For the actual Susan GUI check, make a disposable project copy so the automation never alters your manual decisions:

```sh
mkdir -p artifacts/review
cp artifacts/m1/Susan-project.json artifacts/review/smoke-project.json
node_modules/.bin/electron . -ApplePersistenceIgnoreState YES --project --smoke --review-smoke --project-file artifacts/review/smoke-project.json
```

This checks the added “Now,” first-word drag mode in both directions, real single-click word toggling, real double-click sentence toggling, save/undo/redo, exact original script display, independent scrolling, resynchronization, actual source-video decoding/playback, and export availability without a preview. The test profile is isolated from the normal app. The macOS launch flag avoids the crash-window restoration prompt during automated checks.
