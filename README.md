# MythiCut Studio

Electron remains the chosen desktop framework. Implementation is currently at the M0 media/export feasibility experiment; this is not yet the editor application.

See [the implementation plan](IMPLEMENTATION_PLAN.md) for the accepted behavior and milestones.

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

Run `npm run project` for the new project screen. Add recordings, confirm their order and channel, import or paste the script, and save a project JSON. Reopen with the Open button; the previous save is retained as a `.bak` file. Pasted script and preferences have explicit Apply buttons. Analysis is not connected yet.

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

Candidate suggestions are diagnostic. Exact word matches do not establish take completeness, and Whisper can omit repeated speech. Local LLM review, independent acoustic comparison, protected camera joins, omission/recovery selection, and cut compilation remain pending. The approved curated sample is separate from these new analysis results.

`review:packet` exports the flagged cases as JSON plus a readable Markdown file and a prompt for local or manual ChatGPT review. The packet contains stable case/candidate IDs and transcript text, but no timestamps or filesystem commands. Returned recommendations must pass the existing schema and ID validation before they can affect review state.


## Synchronized transcript review

When a project has analysis results, the project screen presents a synchronized script/transcript review. Variant `A` is the IDE-style two-pane diff: the original script is on the left and the complete recording transcript is on the right. Provisional keeper words are green. Clicking a script sentence seeks its keeper transcript range; clicking a transcript word focuses its script sentence. Scrolling either pane independently resynchronizes the other. Variants `B` (navigator) and `C` (stacked) are available through the bottom prototype switcher using `?variant=B` or `?variant=C`; they are layout experiments backed by the same review state.
