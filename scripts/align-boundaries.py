"""Refine requested source words against audio, using recognized text only.

Independent recognition is included in every window's evidence. Low-confidence
or unsupported words remain unresolved; no script words are injected.
"""
import json, re, sys, wave, time
from pathlib import Path
import numpy as np
import torch, torchaudio
request_path, output_path = map(Path, sys.argv[1:3])
request = json.loads(request_path.read_text())
root = Path(__file__).resolve().parents[1]
torch.set_num_threads(4)
bundle = torchaudio.pipelines.WAV2VEC2_ASR_BASE_960H
model = bundle.get_model(dl_kwargs={'model_dir': str(root / '.local/models')}).eval()
labels=bundle.get_labels(); dictionary={label:i for i,label in enumerate(labels)}
results=[]; started=time.perf_counter()
for index, item in enumerate(request['windows']):
    normalized=[]
    for word in item['words']:
        text=re.sub("[^A-Z']", '', word['text'].upper().replace('’', "'"))
        if text: normalized.append({**word, 'normalized':text})
    if not normalized: continue
    target='|'.join(w['normalized'] for w in normalized)
    with wave.open(request['audioPath'],'rb') as stream:
        assert stream.getframerate()==16000 and stream.getnchannels()==1 and stream.getsampwidth()==2
        stream.setpos(round(item['startMs']*16));pcm=stream.readframes(round((item['endMs']-item['startMs'])*16))
    audio=torch.from_numpy(np.frombuffer(pcm,dtype='<i2').astype(np.float32)/32768).unsqueeze(0)
    with torch.inference_mode():
        emission,_=model(audio);emission=torch.log_softmax(emission,dim=-1)
        greedy=''.join(labels[t] for t in torch.unique_consecutive(emission[0].argmax(-1)).tolist() if t).replace('|',' ')
        targets=torch.tensor([[dictionary[c] for c in target]],dtype=torch.int32)
        path,scores=torchaudio.functional.forced_align(emission,targets,blank=0)
        spans=torchaudio.functional.merge_tokens(path[0],scores[0].exp(),blank=0)
    if [span.token for span in spans]!=targets[0].tolist(): raise ValueError('Alignment changed target characters')
    cursor=0;aligned=[]
    for word in normalized:
        chars=spans[cursor:cursor+len(word['normalized'])];cursor+=len(word['normalized'])+1
        start_ms=item['startMs']+chars[0].start*20;end_ms=item['startMs']+(chars[-1].end-1)*20+25
        score=sum(float(c.score) for c in chars)/len(chars)
        gap=max(((b.start-a.end)*20 for a,b in zip(chars,chars[1:])),default=0)
        aligned.append({'id':word['id'],'text':word['text'],'startMs':start_ms,'endMs':end_ms,'confidence':score,'maxCharacterGapMs':gap,'valid':end_ms>start_ms and start_ms>=item['startMs'] and end_ms<=item['endMs'],'needsReview':score<.5 or gap>300,'method':'local-ctc-alignment'})
    results.append({'id':item['id'],'startMs':item['startMs'],'endMs':item['endMs'],'greedyRecognition':greedy,'words':aligned})
    print(json.dumps({'stage':'align-boundaries','completed':index+1,'total':len(request['windows'])}),flush=True)
output_path.write_text(json.dumps({'schemaVersion':1,'inputId':request['inputId'],'model':'WAV2VEC2_ASR_BASE_960H','elapsedSeconds':time.perf_counter()-started,'windows':results},indent=2))
