# Opening sample — ready for listening review

The approximately 48-second sample uses the final complete opening passage, followed by the later complete question and the description of the empty chair. Repeated attempts between those passages are removed. This is a curated acceptance fixture using local acoustic alignment, not the completed automatic take-selection engine.

- [Play the sample video](artifacts/sample/edit/sample-edit.mp4)
- [Import the matching Premiere XML](artifacts/sample/edit/premiere.xml)
- [Inspect the exact source intervals](artifacts/sample/edit/edit.json)
- [Read the unchanged full raw transcript](artifacts/sample/transcript-review.md)

Open the Electron review window with `npm run sample:review`. It supports continuous playback, replay buttons for joins, and seeking by clicking a transcript word. Dotted words have lower alignment scores. Transcript corrections and edit controls are not implemented in this probe.

## What to review

The main retake removal is approximately **33 seconds** into the sample: the opening retained passage ends at the complete “big spoiler” sentence, before the source’s repeated “today we’re finally…” restart cluster. The later complete “Because today…” passage then continues the edit. This prevents the rejected restart content from leaking into the edit. Listen for clipped sounds and whether the pause feels natural. Smaller edits shorten long pauses between sentences. The final sentence ends at “tragically empty.”

There are no empty timeline gaps. Each side retains up to 0.25 seconds of available source padding, then rounds outward to camera frames. Measured pauses at the retained joins are approximately 0.51–0.56 seconds, within the agreed allowance for outward rounding. Any nominal cut that removes no source frames is merged into its neighboring clip.

The preview is 1280×720 for review. XML specifies a 1920×1080, 24000/1001 sequence and references the original 3840×2160 footage, selected channel 1, and a 50% scale transform. The XML has been checked for well-formedness, but actual Premiere import remains unverified. The video is not a replacement for the original media.

## Word-timing diagnosis

The original raw recognizer output contains zero-duration word intervals. A deterministic audit reproduces the failure directly from Whisper's token JSON, ruling out the app's word-merging code as its source. The first example is “Hey” at a nominal 71.600 seconds. The CLI's full JSON mode already enables token timestamps; enabling word segmentation on a short passage does not eliminate the issue. Changing the analysis window also moves estimates substantially.

The remedy under evaluation is a separate local CTC acoustic alignment stage, using **recognized speech**, not the intended script. This retains omissions and variants instead of forcing nonexistent script words into the audio. The experiment uses torchaudio's Wav2Vec2 base English model, CPU-only, with the dependencies pinned in `requirements-alignment.txt`.

Three windows were aligned: the problematic production note, the opening, and the question passage. All **216 reconstructed word intervals** are positive and within their supplied audio windows. Combined inference time for the final windows was approximately **24.14 seconds** for **108.5 seconds of audio**, excluding model loading. These are short-window measurements, not a full-pipeline performance result.

The final opening “Well” is placed at approximately **130.100 seconds**, compared with the earlier word estimate of **127.600 seconds**. That demonstrates why valid-looking timestamps cannot be trusted as exact cuts. Scores and positive durations alone do not establish acoustic accuracy; listening review is still necessary.

The production-note window has 13 low-score words, the opening has nine, and the question has none under the experimental 0.5 review threshold. That threshold is a diagnostic heuristic, not a calibrated probability. The sample's cut-edge words pass it; low-score interior words remain visible for review.

The cut interface now rejects zero/negative intervals, weak cut-edge evidence, and frame rounding that would enter neighboring speech. Original recognizer artifacts remain unchanged, and still fail the raw audit. They are not silently relabeled as corrected alignment.

## Verification and limits

- Thirteen automated tests pass, including the original zero-duration word pattern at the cut interface and insufficient-padding/rounding cases.
- Source intervals compile contiguously at 24000/1001 fps.
- The preview contains 1,146 frames, approximately 47.7978 seconds. Audio duration differs by less than one millisecond.
- Electron loads the real preview, seeks before/after each join, advances playback, and seeks correctly from a transcript word. Automated playback is muted; no by-ear approval is claimed.
- The scope is this opening sample. The full recording has not been acoustically realigned or automatically cut.
- Actual Premiere import, full-length performance, and real camera rollover footage remain open gates.
- A separate parser issue was observed: the sentence segmenter can split “C.S. Lewis” at the initials. That must be addressed before relying on sentence-by-sentence automatic selection. This sample uses explicit passage ranges, so it does not cut at that erroneous split.

The model hash, resolved dependency versions, per-window timing and scores, and rendered results are retained under `artifacts/sample/alignment/` and `artifacts/sample/edit/`. The additional Python runtime remains a feasibility choice pending wider evaluation.

Technical references: [Whisper CLI timing configuration](https://github.com/ggml-org/whisper.cpp/blob/v1.9.1/examples/cli/cli.cpp), [Torchaudio forced alignment](https://docs.pytorch.org/audio/2.2.0/tutorials/forced_alignment_tutorial.html).
