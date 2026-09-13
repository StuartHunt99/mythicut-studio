# M0 feasibility status

Date: 2026-09-12. **M0 is in progress, not complete.** Electron remains selected.

## Measured environment

| Item | Observed value |
| --- | --- |
| Architecture | x86_64 |
| Model identifier | MacBookPro14,3 |
| CPU | Intel Core i7-7820HQ @ 2.90 GHz |
| RAM | 16 GiB |
| macOS | 15.7.7, build 24G720 |
| Premiere | 26.5.0 |
| Node / npm | 24.18.0 / 11.16.0 |
| FFmpeg | 8.1.2 |
| Electron | 44.3.0, pinned in package and lockfile |

Hardware values were read from this machine. They supersede assumptions based on purchase year. The sample benchmark subsequently installed whisper-cpp 1.9.1 and llama.cpp build 10050 through Homebrew. Local model files live under ignored `.local/models/`; final model selection remains pending.

## Completed checks

- Four Node tests passed: outward word-edge rounding, exact source file-edge preservation, contiguous sequence placement, invalid interval rejection, and basic XML linkage/escaping (grouped into four test cases).
- Generated two 1080p/30 fps source files with distinct colors and tones. Retained the last two seconds of the first and first 1.5 seconds of the second, preserving both file edges at their join.
- Rendered a 960×540 preview from the same compiled interval list used for XML. FFprobe reports 105 video frames and 3.5 seconds of audio.
- Generated FCP7 XML and checked that it is well-formed with `xmllint`. This does not verify Premiere import compatibility.
- Launched Electron and verified the preview's 3.5-second duration, 960×540 dimensions, decoded blue and green samples after seeking, and advancing playback. The automated check was muted; a human listening check is still needed.
- Installed the pinned Electron package; npm reported no known vulnerabilities in that install's audit.

The media experiment took approximately 1.5 seconds on its latest run. This is a short synthetic generation/render timing, **not** an inference benchmark or proof of the processing-time acceptance requirement.

## Reproduce and inspect

```sh
npm test
npm run feasibility
npm run smoke
npm start
```

Generated, ignored files are under `artifacts/m0/`: `first.mov`, `second.mov`, `preview.mp4`, `timeline.json`, `premiere.xml`, `results.json`, and `electron-smoke.json`.

## Still required before closing M0

1. Representative recording and script received and processed (see below). Camera rollover footage remains unavailable; that acceptance case is still open.
2. Benchmark local transcription, timing refinement, and local LLM candidates on this machine. Select models and pin their artifacts only after comparing accuracy, time, and memory.
3. Import the generated XML into Premiere and inspect source ranges, linked audio, file paths, and the two-second join. No native Premiere UI automation was available in this session; this was not performed.
4. Extend media experiments to actual 4K inputs, fill scaling, noninteger frame rates, source timestamp offsets, and variable-rate behavior. Current experiment code intentionally handles only matching integer frame rates.
5. Evaluate a real mid-word camera split; a synthetic exact join only validates interval preservation.
6. Complete a fresh-project full-duration run, including continuous preview preparation, with processing time / source duration < 2.0.

The Electron window is a small playback probe, not the planned React editing UI. A command-line transcription benchmark now exists; the complete automatic take-selection workflow is not implemented yet.

## Real recording benchmark

Source: `P1100565.MOV`, with the user's matching `Untitled document.txt`, received from their SusanHell folder. Originals were only read. Copies of script and extracted analysis audio are in ignored `artifacts/sample/`.

| Observation | Measured result |
| --- | --- |
| Source duration | 1,692.691 seconds (28:12.691) |
| Video | 3840×2160 H.264 High 4:2:2, 10-bit, 24000/1001 fps |
| Audio | Two channels, 48 kHz PCM; channel 1 selected |
| Channel 1 levels | Mean -23.6 dBFS, peak -1.3 dBFS |
| Analysis extraction | Approximately 3.33 seconds; 16 kHz mono PCM |
| Script parsing | 101 sentence candidates, 39 nonempty paragraphs, 2 bracketed annotations excluded |
| Transcription | Whisper base.en, CPU, four threads, DTW enabled, flash attention disabled |
| Full transcription elapsed | 348.62 seconds (5:48.62) |
| Transcription/source ratio | 0.206, approximately 4.86× real-time speed |
| Transcript output | 210 segments, approximately 3,538 reconstructed words |
| Fractional-rate media experiment | 192 video frames and 8.008 seconds of audio/video from two technical excerpts |
| Excerpt preview render | Approximately 11.94 seconds |
| Automated tests | Ten passing after adding rational-rate, script-parser, and recommendation-validation cases |

The full transcription JSON, TXT, SRT, and a readable timestamped Markdown transcript are in `artifacts/sample/`. Open [the transcript](artifacts/sample/transcript-review.md). This is raw recognition, not approved dialogue or a rough cut.

The initial diagnostic sentence matcher found possible matches for 86 of 101 script sentence candidates and multiple possible occurrences for 24. These are heuristic search results, **not** an accuracy score or proof that the other 15 sentences were omitted. The matcher does not yet implement the full attempt-selection algorithm.

The recognizer's ordinary token intervals produced 282 reconstructed words with nonpositive durations. For 1,176 words, at least one DTW anchor lies more than 250 ms outside the ordinary token interval. These are two different timing estimates; disagreement alone does not identify which estimate is accurate. They must not be used blindly as cut points. The raw transcript is useful for review, while exact word timing remains a release gate.

The first run used `/usr/bin/time -l`. Whisper completed and produced its full output, and elapsed time was printed, but the resource wrapper then failed because the sandbox blocked `sysctl kern.clockrate`. Therefore peak-memory measurement is unavailable, and the wrapper's nonzero exit is not evidence that transcription failed. A Node timing wrapper has been added for subsequent runs.

The real-media XML is well-formed and references the original source with 23.976-rate metadata, original dimensions, and a proposed 50% fill transform. It has not been imported into Premiere. Technical excerpts are not editorial selections. Tests still do not establish VFR support or nonzero source-start/timecode interpretation in Premiere.

The Qwen3 1.7B Q4_K_M model was downloaded from the ggml-org repository for local testing. The installed llama CLI requires a loopback port, blocked in the sandbox. Automatic approval review initially rejected execution because its approval service reported a usage limit; after the stated reset time and the user's continuation, the retry was approved.

The first model attempt failed to initialize the grammar sampler. Its process exited zero despite an inference error, so process exit alone is insufficient to establish success. A single retry without grammar-constrained decoding produced valid JSON, checked by the application's validator against the case and candidate IDs. It selected `s2-c3`, the last of three matching passages, approximately 2:12–2:19 into the recording. Reported inference throughput was 29.4 prompt tokens/second and 7.6 generated tokens/second. The response is in `artifacts/sample/llm-validated-recommendation.json`.

This is one successful recommendation, not a validated general selection policy. Its explanation emphasized similarity; future cases must demonstrate that a later acceptable variation wins over an earlier closer match. Application validation rejects unknown IDs, injected fields, stale cases, and false resolution. The model did not change the timeline.

A separate first-120-second transcription comparison with default timing (DTW disabled) took 57.13 seconds. Ordinary token intervals still included nonpositive durations (22 text-bearing tokens, versus 21 in the comparable DTW-run window). Simply disabling DTW does not solve timing reliability. Token counts differ from the reconstructed-word counts reported above.

Model SHA-256 hashes are recorded in `artifacts/sample/model-sha256.txt`. Downloads are model files only; source footage, audio, and script were not uploaded to a cloud inference service.

The full <2.0 processing-ratio gate remains open: this run did not include completed LLM review or a full assembled-cut preview.

## Aligned opening sample

See [Sample Edit Review](SAMPLE_EDIT_REVIEW.md) for the approximately 48-second video, matching Premiere XML, word-alignment findings, and listening instructions. A separate CPU acoustic alignment experiment now produces valid word intervals for three sampled windows. Invalid recognizer intervals are rejected by the new cut interface instead of being used as cut points.

The sample removes intervening retakes and shortens long sentence pauses. It is a curated fixture and has not been approved by ear or imported into Premiere. Full automatic selection and full-recording acoustic timing remain unfinished. Electron playback and text seeking are verified; thirteen automated tests pass.


## Approved sample and M1 project foundation

The user confirmed the corrected 50.425375-second sample is correct. Record listening acceptance separately from render-generated diagnostics: `artifacts/sample/edit/user-acceptance.json`. Whisper omitted a real repeated “Because today we are”; independent Wav2Vec2 recognition detected it. Recognition disagreements must be reviewed before forced alignment or take selection, even when interval durations are valid. The successful curated correction does not establish full automatic recognition or selection accuracy.

M1 initial slice now supports a sandboxed Electron import screen with narrow IPC commands, natural filename ordering and manual reorder, actual stream/channel selection, strict UTF-8 script import and bracket validation, cancellable ffprobe inspection, and versioned JSON save/reopen with previous-save backup and source-change warnings. It uses the existing JavaScript/Electron runtime for this slice; React/TypeScript conversion and background job architecture remain pending.

Validation: 15 Node tests pass, including interrupted temporary writes, invalid-save preservation, reopening, missing source warnings, and invalid channel rejection. Electron smoke checks verify the IPC boundary, script parsing, rejected malformed input without lost state, and disabled renderer Node access. The actual 4K Susan source and 101-sentence script imported, saved, and reopened without warnings in `artifacts/m1/Susan-project.json`.

This is not all of M1: channel audition and silence measurement, analysis input freeze, durable job checkpoints, full time mappings, and review autosave remain pending. Premiere import, rollover media, and full end-to-end performance remain open M0 gates.


## Saved-project analysis connected

Analysis now runs from the project screen through an Electron utility process, with a matching development CLI. The selected channel is extracted with FFmpeg, Whisper produces per-source transcript files, and token-derived words feed diagnostic sentence matching. Completed source transcripts are checkpointed by input/model identity. Cancellation terminates the active child process; failure state is saved and unfinished work is retried. Input editing is blocked after analysis starts. Each completed job retains its own diagnostic record.

The full Susan project produced 3,483 reconstructed words, candidate evidence for 82 of 94 script sentences, and 19 sentences with multiple candidates after abbreviation-aware script sentence parsing. 221 word intervals require timing refinement. The GUI exposes word-level transcript estimates and source-time candidates; a Markdown report is saved beside the result JSON. Latest-candidate labels are chronological context, not take recommendations. An older exact wording match must not override a later minor variation merely because it scores higher.

Validation: 18 Node tests pass. Focused analysis tests verify repeated-word preservation, source-scoped IDs, rejection of unverified cross-file candidate spans, checkpoint reuse/input invalidation/failure retry, and live subprocess cancellation. Electron checks verify analysis input freeze, evidence reopening, and cached analysis through the utility worker. A cached resume completed in under one second; this is not a cold full-pipeline benchmark.

Remaining: acoustic disagreement detection in the general pipeline, word timing refinement, actual restart/attempt modeling, omission/recovery rules, local LLM uncertainty review, and proposed-cut compilation. The imported project's results are evidence-only. Recognition warnings remain visible; the approved curated video has not been rebuilt from these candidate matches.

## Full-source acoustic evidence

An independent Wav2Vec2 CTC pass now covers the complete 1,692.691-second source in 25-second overlapping windows. It produced 3,592 acoustically recognized words and a cached, source-timestamped export at `artifacts/sample/acoustic-full.json`. The duplicate detector found 631 repeated 3–6-word phrases; around the known restart it finds `because today we` at 214.200–215.065 and again at 216.160–217.085. This is evidence for an attempt boundary, not an automatic take decision. Acoustic matching currently finds 89 of 94 script sentences and marks 47 for review, so it is not yet suitable for unsupervised full-cut generation.

The take-selection module now models minor wording variation, complete versus incomplete candidates, chronological candidates, omission flags, recovered endings, and unverified cross-file spans. It chooses a provisional latest complete candidate only when local evidence permits and keeps flags for LLM or human review. The reviewed Susan result is stored in `artifacts/sample/acoustic-selection-evidence.json` and remains evidence-only.

The analysis screen now exposes explicit per-sentence **Approve candidate**, **Reject all**, and **Clear decision** commands. Decisions are stored in `project.review.decisions`, increment the project revision, and are included when the project is reopened. Automatic candidates remain provisional until approved; the renderer cannot write an unreviewed candidate into a timeline.

The flagged cases can be exported with `npm run review:packet -- artifacts/m1/Susan-project.json`. The packet has 41 cases in this recording and produces JSON, Markdown, and a copy/paste prompt. It deliberately excludes timestamps and paths from the model input; only validated candidate IDs can be imported later.


## Synchronized review GUI

The analysis UI now includes a synchronized script/transcript diff view. It renders the full original script and recording word transcript, marks provisional keeper ranges in green, and links click and independent-scroll navigation in both directions. Three prototype layouts are available on the same route: IDE split (`A`), compact navigator (`B`), and stacked panes (`C`). The bottom switcher preserves the selected variant in the URL.

Review decisions remain separate from provisional green ranges. A green range is evidence from the take selector until the user approves it. Transcript timestamps are estimates; invalid timing words remain visibly marked and cannot compile to a cut.
