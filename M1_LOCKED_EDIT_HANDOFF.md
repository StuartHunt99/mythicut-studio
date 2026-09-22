# M1 locked edit handoff

The project screen now has **Lock edit for B-roll** after phase-1 review. This compiles the same reviewed selection used by edited playback and Premiere XML, then writes an immutable, fingerprinted JSON snapshot next to the project at `<project.json>.handoffs/<fingerprint>.json`. The project stores only the active fingerprint. If a later review changes the edit, the screen reports that the lock is older; locking again creates a new snapshot and leaves the earlier one untouched. Copy the adjacent `.handoffs` folder with the project when moving computers.

Each retained transcript word keeps its ID, recognized text, source recording ID, and **unchanged phase-1 source timestamps**. Its integer sequence-frame placement is derived only by mapping those timestamps through the same compiled clip `inFrame` and `start` values exported to Premiere XML. It is not a second transcription or an estimate from a rendered edit. The snapshot also contains the compiled source intervals, sentence and paragraph passages, neighboring passage text, and an extractive whole-script context line made from paragraph openings. That line is a deterministic placeholder, **not** a semantic LLM summary. Bracketed script directions and discarded words do not enter the spoken transcript. Invalid retained word timing blocks a lock rather than silently supplying a misleading position; refine or remove the word in phase 1.

The lock does not freeze the phase-1 review controls. A changed review produces a distinct fingerprint and must be explicitly locked again before a future B-roll plan uses it. M1 does not create B-roll beats, search artwork, or export multi-track image edits.

## Evaluation-only reference import

If the reference edit cannot be opened as a normal MythiCut project, an evaluation manifest can combine **the original phase-1 transcription words** with the **compiled edit intervals** used for XML export:

```text
npm run m1:reference -- <source-words-and-edit.json> <test-project-path>
```

The last argument identifies where the adjacent `.handoffs` folder is written; it need not be a working MythiCut project. The manifest format is:

```json
{
  "width": 1920,
  "height": 1080,
  "sources": {
    "camera": { "filename": "original.mov", "fps": { "numerator": 30, "denominator": 1 }, "frames": 900 }
  },
  "timeline": {
    "fps": { "numerator": 30, "denominator": 1 },
    "duration": 30,
    "intervals": [
      { "sourceId": "camera", "inFrame": 300, "outFrame": 330, "start": 0, "end": 30, "wordIds": ["ref-1", "ref-2"] }
    ]
  },
  "wholeScriptSummary": "Optional human-provided overview.",
  "words": [
    { "id": "ref-1", "mediaId": "camera", "text": "Example", "startMs": 10200, "endMs": 10400 },
    { "id": "ref-2", "mediaId": "camera", "text": "speech.", "startMs": 10410, "endMs": 10600 }
  ]
}
```

Word times must refer to the **original source recording**, not the edited video's clock. The edit intervals must be the same frame ranges that the phase-1 XML uses. The command validates their contiguous sequence placement and maps words through them; it does not transcribe a baked video, infer cuts, or extract artwork. It marks the handoff `reference-fixture` and `forEvaluationOnly` so it cannot be mistaken for a reviewed phase-1 lock. Do not commit reference media, transcripts, or generated handoffs to Git.
