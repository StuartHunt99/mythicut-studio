"""M0 local alignment experiment: recognized speech, never the intended script.

Uses torchaudio's CTC forced_align and merge_tokens interfaces. Model emission
spans are estimates and must still be auditioned at editorial cut boundaries.
"""
import json
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np
import torch
import torchaudio

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "artifacts/sample/alignment"
OUT.mkdir(parents=True, exist_ok=True)
torch.set_num_threads(4)
torch.hub.set_dir(str(ROOT / ".local/torch-hub"))
bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
started = time.perf_counter()
model = bundle.get_model(dl_kwargs={"model_dir": str(ROOT / ".local/models")}).eval()
labels = bundle.get_labels()
dictionary = {label: index for index, label in enumerate(labels)}
transcription = json.loads((ROOT / "artifacts/sample/base-en.json").read_text())["transcription"]

windows = [
    {"id": "regression", "start": 68, "end": 82, "segments": [7]},
    {"id": "opening", "start": 112, "end": 168.5, "segments": list(range(12, 19))},
    {"id": "question", "start": 211, "end": 249, "segments": list(range(24, 28))},
]
results = []
for window in windows:
    if sys.argv[1:] and window["id"] not in sys.argv[1:]:
        results.append(json.loads((OUT / f"{window['id']}.json").read_text()))
        continue
    # Use source-time windows rather than segment indices, which change when
    # Whisper output settings change. Preserve audited corrections explicitly.
    if window["id"] == "question":
        # Audited against independent greedy acoustic recognition: Whisper
        # omitted the initial "Because today we are" restart at 214.2 seconds.
        text = (ROOT / "scripts/sample-question-transcript.txt").read_text().strip()
    else:
        selected = [s for s in transcription if s["offsets"]["from"] >= window["start"] * 1000 and s["offsets"]["to"] <= window["end"] * 1000]
        text = " ".join(s["text"] for s in selected)
    words = re.findall(r"[A-Z]+(?:'[A-Z]+)*", text.upper().replace("’", "'"))
    target_text = "|".join(words)
    targets = torch.tensor([[dictionary[c] for c in target_text]], dtype=torch.int32)
    with wave.open(str(ROOT / "artifacts/sample/channel-1.wav"), "rb") as stream:
        assert stream.getframerate() == 16000 and stream.getnchannels() == 1 and stream.getsampwidth() == 2
        stream.setpos(round(window["start"] * 16000))
        pcm = stream.readframes(round((window["end"] - window["start"]) * 16000))
    waveform = torch.from_numpy(np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768).unsqueeze(0)
    mark = time.perf_counter()
    with torch.inference_mode():
        emission, _ = model(waveform)
        emission = torch.log_softmax(emission, dim=-1)
        path, scores = torchaudio.functional.forced_align(emission, targets, blank=0)
        spans = torchaudio.functional.merge_tokens(path[0], scores[0].exp(), blank=0)
    if [span.token for span in spans] != targets[0].tolist():
        raise ValueError("Alignment did not preserve target characters")
    greedy = torch.unique_consecutive(emission[0].argmax(dim=-1)).tolist()
    greedy_text = "".join(labels[token] for token in greedy if token != 0).replace("|", " ")
    aligned = []
    cursor = 0
    for index, word in enumerate(words):
        chars = spans[cursor:cursor + len(word)]
        # This model's encoder advances 320 samples with a 400-sample receptive field.
        start_ms = window["start"] * 1000 + chars[0].start * 20
        end_ms = window["start"] * 1000 + (chars[-1].end - 1) * 20 + 25
        confidence = sum(float(char.score) for char in chars) / len(chars)
        aligned.append({"id": f"{window['id']}-w{index + 1}", "text": word, "startMs": start_ms, "endMs": end_ms, "alignmentScore": confidence, "needsReview": confidence < 0.5})
        cursor += len(word) + 1
    if any(word["endMs"] <= word["startMs"] or word["startMs"] < window["start"] * 1000 or word["endMs"] > window["end"] * 1000 for word in aligned):
        raise ValueError("Invalid aligned source interval")
    result = {**window, "text": text, "greedyRecognition": greedy_text, "words": aligned, "elapsedSeconds": time.perf_counter() - mark}
    results.append(result)
    (OUT / f"{window['id']}.json").write_text(json.dumps(result, indent=2))
    print(json.dumps({"window": window["id"], "words": len(aligned), "seconds": result["elapsedSeconds"], "lowConfidence": sum(word["needsReview"] for word in aligned)}), flush=True)

(OUT / "results.json").write_text(json.dumps({"schemaVersion": 1, "model": "WAV2VEC2_ASR_BASE_960H", "torch": torch.__version__, "torchaudio": torchaudio.__version__, "elapsedSeconds": time.perf_counter() - started, "windows": results}, indent=2))
