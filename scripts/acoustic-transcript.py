"""Independent CTC speech evidence with source-time word boundaries.

Overlapping context windows own nonoverlapping 25-second source regions.
Never align the intended script onto speech; this recognizes actual audio.
"""
import json, sys, wave, time, hashlib
from pathlib import Path
import numpy as np
import torch, torchaudio

source, destination = map(Path, sys.argv[1:3])
root = Path(__file__).resolve().parents[1]
torch.set_num_threads(4)
bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
model = bundle.get_model(dl_kwargs={'model_dir': str(root / '.local/models')}).eval()
labels = bundle.get_labels()
with wave.open(str(source), 'rb') as stream:
    assert stream.getframerate() == 16000 and stream.getnchannels() == 1 and stream.getsampwidth() == 2
    duration = stream.getnframes() / 16000
identity = {'path': str(source.resolve()), 'size': source.stat().st_size, 'mtime': source.stat().st_mtime_ns, 'model': 'WAV2VEC2_ASR_BASE_960H', 'version': 1}
cache = destination.with_suffix('.chunks'); cache.mkdir(parents=True, exist_ok=True)
key = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
all_words = []; started = time.perf_counter()
for index, core_start in enumerate(np.arange(0, duration, 25.0)):
    core_end = min(duration, core_start + 25)
    start = max(0, core_start - 3); end = min(duration, core_end + 3)
    cached = cache / f'{key}-{index}.json'
    if cached.exists(): words = json.loads(cached.read_text())
    else:
        with wave.open(str(source), 'rb') as stream:
            stream.setpos(round(start * 16000)); pcm = stream.readframes(round((end-start) * 16000))
        audio = torch.from_numpy(np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768).unsqueeze(0)
        with torch.inference_mode():
            output, _ = model(audio)
            probabilities = output[0].softmax(-1)
            path = probabilities.argmax(-1).tolist()
        words = []; chars = []; previous = 0
        def flush():
            if chars:
                words.append({'text': ''.join(c['text'] for c in chars), 'startMs': round(start*1000 + chars[0]['start']*20), 'endMs': min(round(end*1000), round(start*1000 + (chars[-1]['end']-1)*20 + 25)), 'acousticConfidence': sum(c['p'] for c in chars)/len(chars)})
                chars.clear()
        for frame, token in enumerate(path):
            if token == previous:
                if token and labels[token] != '|' and chars: chars[-1]['end'] = frame+1
                continue
            previous = token
            if token == 0: continue
            if labels[token] == '|': flush()
            else: chars.append({'text': labels[token], 'start': frame, 'end': frame+1, 'p': float(probabilities[frame, token])})
        flush()
        cached.write_text(json.dumps(words))
    owned = [w for w in words if core_start*1000 <= (w['startMs']+w['endMs'])/2 < core_end*1000]
    all_words.extend(owned)
    print(json.dumps({'chunk': index+1, 'secondsProcessed': float(core_end), 'duration': duration, 'wordCount': len(all_words)}), flush=True)
# A word straddling an ownership edge can shift its midpoint between windows.
# Collapse only acoustically overlapping duplicates; sequential repeats survive.
merged = []
for word in sorted(all_words, key=lambda w: w['startMs']):
    if merged and word['text'] == merged[-1]['text'] and word['startMs'] < merged[-1]['endMs']:
        merged[-1]['endMs'] = max(merged[-1]['endMs'], word['endMs']); continue
    merged.append(word)
for index, word in enumerate(merged):
    word.update({'id': f'a{index+1}', 'valid': word['endMs'] > word['startMs'], 'needsReview': word['acousticConfidence'] < .45})
destination.write_text(json.dumps({'schemaVersion': 1, 'identity': identity, 'duration': duration, 'elapsedSeconds': time.perf_counter()-started, 'words': merged}, indent=2))
