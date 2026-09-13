"""Independent acoustic check: catch repetitions Whisper can omit."""
import json, sys, wave
from pathlib import Path
import numpy as np
import torch, torchaudio
root = Path(__file__).resolve().parents[1]
torch.set_num_threads(4)
bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
model = bundle.get_model(dl_kwargs={'model_dir': str(root / '.local/models')}).eval()
labels = bundle.get_labels()
failed = False
for filename in sys.argv[1:]:
    with wave.open(filename, 'rb') as f:
        assert f.getframerate() == 16000 and f.getnchannels() == 1
        samples = np.frombuffer(f.readframes(f.getnframes()), dtype='<i2').astype(np.float32)/32768
    with torch.inference_mode():
        emissions, _ = model(torch.from_numpy(samples).unsqueeze(0))
    ids = torch.unique_consecutive(emissions[0].argmax(-1)).tolist()
    text = ''.join(labels[i] for i in ids if i).replace('|',' ')
    normalized = text.replace('TO DAY', 'TODAY')
    count = normalized.count('BECAUSE TODAY')
    result = {'audio': filename, 'text': text, 'becauseTodayCount': count, 'passed': count == 1}
    Path(filename).with_suffix('.acoustic-check.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
    failed |= not result["passed"]
sys.exit(1 if failed else 0)
