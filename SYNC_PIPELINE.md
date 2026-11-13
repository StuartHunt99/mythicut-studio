# Original-media synchronization and Premiere XML

## User workflow

The initial **Import** workspace has a recording list, **Import files**, an editable script box with **Import script**, and **Synchronize**. Files are classified as camera video or external audio. Each group sorts by embedded recording timestamp when all its members have one; otherwise it uses natural filename order. Ordering controls and channel selection remain available.

Synchronization runs in an Electron utility process. The user can cancel it. A successful run offers **Review sync** and **Continue to Edit**. Reviewing is optional: Continue accepts the current map, saves the project, and starts transcription. The Edit workspace opens while analysis runs. Camera-only projects can continue directly. Script edits are committed by Save script, Save, Synchronize, Continue, or workspace navigation; they do not invalidate synchronization. Analysis freezes the import inputs as before.

Review shows each original file's session position, gaps, timing evidence, and editable start positions. A 12-second sample can compare synchronized external dialogue against camera guide audio. Picture playback references the original video directly. If Chromium cannot decode its codec, the sample audio remains available and **Export sync XML for Premiere** provides picture review without proxies. Closing review stops sample playback.

## Code map

| Responsibility | Implementation |
| --- | --- |
| Import and persisted media records | `src/project.mjs` |
| Log spectral features, FFT correlation, multi-window alignment | `src/sync/features.mjs` |
| Cached audio extraction and orchestration | `src/sync/job.mjs` |
| Input identity, session constraints, manual corrections, acceptance | `src/sync/session.mjs` |
| Independent audio/video intervals and source-time intersections | `src/sync/timeline.mjs` |
| Sample-exact analysis/playback audio assembly | `src/sync/dialogue.mjs` |
| Premiere FCP7 XML | `src/premiere-xml.mjs` |
| Import UI | `electron/import-view.js`, Import markup in `electron/project.html` |
| Worker and IPC | `electron/sync-worker.cjs`, `electron/project-ipc.cjs` |

## Matching and time mapping

The engine decodes only the selected audio channel at 8 kHz for synchronization. Ten log-energy frequency bands are sampled every 10 ms. Normalized FFT correlation searches several windows throughout the shorter file against the other file. A denser retry handles difficult partial overlaps. Peaks need sufficient correlation and separation from competing positions. Silence, unrelated recordings, and exact repeated regions can remain unmatched.

Consistent anchors form a robust offset/clock-rate fit. Insignificant slopes use the median measured offset rather than extrapolating noisy slopes to the source origin. Each accepted pair supplies `startB - startA`; higher-confidence edges place connected recordings first and other edges check consistency. File order is a constraint, not an assumption that consecutive files touch. Distinct connected groups remain unresolved until a manual position connects them to the session. Material drift (over 20 ms across measured anchors), contradictory relationships, or overlapping sequential camera files prevent Continue.

The implementation supports one-to-many relationships in either direction and many-to-many chains, including partial overlaps. At least two consistent acoustic windows are required. No audio bridge means no measured gap duration; filenames alone cannot recover it. Embedded timestamps currently determine ordering, not automatic cross-device clock alignment. Manual starts resolve otherwise unplaced groups, and corrections survive reruns against unchanged inputs.

## Editing and export

Transcript words retain camera-local timestamps and identities. When external audio is present, transcription receives a camera-duration dialogue WAV assembled from the synchronized recorder intervals. Recorder gaps use camera audio where available; a video without camera audio cannot silently fill missing dialogue. The full sync review retains audio beyond camera coverage. The current talking-head editor transcribes only camera-covered passages, so audio-only passages are not automatically added to the edited video.

Cuts intersect the accepted session map to generate independent audio source intervals. A cut crossing a recorder boundary becomes multiple audio clip items while its camera picture remains continuous. Edited XML retains disabled camera guide clips on A1 and selected-channel dialogue on A2. The full sync XML retains whole recorder files, with overlapping recorders on separate lanes. In an edited interval with overlapping recorder coverage, the first recorder in confirmed order supplies dialogue. Both exports reference original MOV/WAV/etc. paths. No synchronized video or proxy is required.

XML boundaries are rounded together to video frames; this version does not claim sample-accurate Premiere XML import. Optional edited preview audio uses those same rounded source intervals. Locked edit handoffs include the external audio geometry, so downstream B-roll cannot silently ignore a changed audio map.

## Persistence and dependencies

The existing version-1 project JSON gains optional audio-only media entries and a `synchronization` map. Existing camera-only projects retain their embedded-audio workflow. The map stores the media/channel fingerprint, proposed placements, acoustic evidence, issues, manual corrections, and an explicit acceptance flag. Adding/removing/reordering media or changing a channel invalidates it. Script and edit settings are not part of its identity. Project saves and the normal `.bak` preserve the map; it travels with the project. `<project>.cache/sync` contains rebuildable feature caches and is not required for portability.

The engine is application JavaScript using pinned MIT-licensed FFT.js 4.0.4. It requires no Python runtime, hosted service, paid sync SDK, or editor API. FFmpeg/FFprobe remain machine-local prerequisites. See `THIRD_PARTY_NOTICES.md`; existing media-tool packaging is not yet license-audited for distribution.

## Verification and remaining limits

Node tests cover opposite-direction partial overlaps, gain/polarity changes, silence, unrelated/repeated recordings, clock drift, unknown gaps, silent-camera coverage, many-to-many placement, XML linking, and recorder boundaries. With FFmpeg available, `test/sync-media.test.mjs` creates five synthetic media files with clap transients, probes them, synchronizes their gaps and rollovers, reuses caches, preserves manual corrections, saves/reopens the map, assembles duration-checked dialogue audio, and exercises transcription with a test recognizer while retaining camera-local word identities. It publishes only generated fixtures under ignored `artifacts/sync-check` for the isolated Electron Import smoke test.

The Electron smoke test exercises the actual Synchronize button and utility worker, script draft saving, optional review, and five-lane layout. On this Windows machine the built-in engine synchronized the user's six original E71 MOVs against the 24-minute WAV in 27.2 seconds with fresh feature caches, and 16.4 seconds with cached features. Each clip had six or seven agreeing anchors, correlations of 0.868–0.895, and measured drift below 11 ms across its anchors; no session issues remained. This run decoded audio only and wrote a separate provisional project and original-media XML under ignored `artifacts/sync-e71`. These timings are one local run, not a cross-machine performance guarantee. The direct Premiere UI check could not proceed because desktop app approval timed out, so import correctness remains unconfirmed.

The user confirmed successful synchronization on November 12, 2026.

Production Premiere import of the new independent-audio XML, subframe slips, and rate correction still need live acceptance. Constant matching video frame rates and zero stream starts are required; variable/mixed video rates and nonzero stream offsets fail explicitly. Drift is detected and reported, not corrected. The matcher is not a universal guarantee for silent cameras, extremely short overlaps, severe noise, or recordings without common sound. Full cross-platform packaging and third-party comparative benchmarks remain open.
