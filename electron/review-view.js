/* DOM-only review surface. Files and selection validation belong to the main process. */
let disposeReview = () => {};
let reviewFocus = null;
let reviewPicked = new Set();
function renderTranscriptReview({ project, result, review, error, onCommand, onSeek }) {
  disposeReview();
  const shell = document.getElementById('review-diff');
  const oldScroll = [...shell.querySelectorAll('.pane')].map(p=>p.scrollTop);
  const oldProject = shell.dataset.projectId;
  if (oldProject !== project.id) { reviewPicked = new Set(); reviewFocus = null; }
  shell.dataset.projectId = project.id;
  shell.classList.remove('hidden');
  if (!review) { shell.textContent = error || 'Review unavailable'; return; }
  const words = new Map(result.words.map(w=>[w.id,w]));
  reviewPicked = new Set([...reviewPicked].filter(id=>words.has(id)));
  const keepers = new Set(review.selectedWordIds);
  const suggestions = new Set();
  for(const choice of result.takeSelection)if(choice.selected)for(let index=choice.selected.startIndex;index<=choice.selected.endIndex;index++)suggestions.add(result.words[index]?.id);
  const ranges = new Map(review.ranges.map(r=>[r.sentenceId,r]));
  const choices = new Map(result.takeSelection.map(c=>[c.sentence.id,c]));
  const make = (tag, cls, text) => { const e=document.createElement(tag); if(cls)e.className=cls; if(text!==undefined)e.textContent=text; return e; };
  const toolbar=make('div','review-toolbar');
  const title=make('strong',null,'Script & recording');
  const count=make('span','selection-count');
  const actions=make('div','review-actions');
  const buttons=[];
  const send=command=>onCommand({...command,analysisId:review.analysisId,revision:review.revision});
  for (const [label, action] of [['Keep','keep'],['Remove','remove'],['Reset to suggestion','reset']]) {
    const button=make('button',null,label); button.dataset.reviewAction=action;
    button.onmousedown=e=>e.preventDefault();
    button.onclick=()=>send({type:'words',action,wordIds:[...reviewPicked]}); actions.append(button); buttons.push(button);
  }
  for(const [label,type,enabled] of [['Undo','undo',review.canUndo],['Redo','redo',review.canRedo]]) {
    const button=make('button',null,label); button.disabled=!enabled; button.dataset.reviewAction=type;
    button.onclick=()=>send({type}); actions.append(button);
  }
  toolbar.append(title,count,actions);
  const help=make('p','review-help','Green words are exported; blue underlines show the original suggestion. Drag mode follows the first word: highlighted removes the range, unhighlighted keeps it. Single click toggles one word; double click applies the sentence majority.');
  const detail=make('div','review-context');
  const content=make('div','diff');
  const scriptPane=make('div','pane script'); scriptPane.tabIndex=0; scriptPane.setAttribute('aria-label','Original script');
  const transcriptPane=make('div','pane recording'); transcriptPane.tabIndex=0; transcriptPane.setAttribute('aria-label','Recording transcript');
  scriptPane.append(make('div','pane-title','Original script'));
  transcriptPane.append(make('div','pane-title','Recording transcript · green = kept'));
  const scriptText=make('div','script-original'); scriptPane.append(scriptText);
  const scriptElements=new Map(), wordElements=new Map();
  const pendingWordClicks=new Map();
  const doubleClickWindowMs=800;
  const drawOriginal=(parent,start,end)=>{
    let cursor=start;
    for(const note of project.script.annotations.filter(a=>a.end>start && a.start<end)) {
      parent.append(document.createTextNode(project.script.original.slice(cursor,Math.max(cursor,note.start))));
      const right=Math.min(end,note.end); parent.append(make('span','script-note',project.script.original.slice(Math.max(cursor,note.start),right))); cursor=right;
    }
    parent.append(document.createTextNode(project.script.original.slice(cursor,end)));
  };
  let offset=0;
  for(const sentence of project.script.sentences) {
    drawOriginal(scriptText,offset,sentence.start);
    const line=make('span','script-sentence'); line.dataset.sentenceId=sentence.id; line.tabIndex=0;
    drawOriginal(line,sentence.start,sentence.end);
    line.onclick=()=>{ if (!window.getSelection()?.isCollapsed) return; focusSentence(sentence.id,true); pick(ranges.get(sentence.id)?.wordIds.filter(id=>keepers.has(id))??[]); };
    line.onkeydown=e=>{if(e.key==='Enter'){line.click();e.preventDefault();}};
    scriptText.append(line); scriptElements.set(sentence.id,line); offset=sentence.end;
  }
  drawOriginal(scriptText,offset,project.script.original.length);
  const sentenceForWord=new Map();
  for(const choice of result.takeSelection) {
    const decision=project.review.decisions[choice.sentence.id];
    const candidate=decision?.action==='approve' ? choice.candidates.find(c=>c.id===decision.candidateId) : choice.selected;
    if(candidate) for(let i=candidate.startIndex;i<=candidate.endIndex;i++) sentenceForWord.set(result.words[i]?.id,choice.sentence.id);
  }
  let previous=null;
  for(const word of result.words) {
    if (previous?.mediaId!==word.mediaId) { const label=make('div','source-label',project.media.find(a=>a.id===word.mediaId)?.filename??word.mediaId); transcriptPane.append(label); }
    else if (word.startMs-previous.endMs>1000 && !(keepers.has(previous.id)&&keepers.has(word.id))) transcriptPane.append(make('div','record-gap'));
    const span=make('span','record-word'); span.dataset.wordId=word.id; span.tabIndex=0;
    if (keepers.has(word.id)) span.classList.add('keeper');
    if (!word.valid || word.needsReview) span.classList.add('uncertain');
    if (suggestions.has(word.id)) span.classList.add('suggested-word');
    if (review.owners[word.id]||sentenceForWord.get(word.id)) span.dataset.sentenceId=review.owners[word.id]||sentenceForWord.get(word.id);
    span.title=`${(word.startMs/1000).toFixed(2)}–${(word.endMs/1000).toFixed(2)}s${review.overrides[word.id]?' · manual '+review.overrides[word.id]:''}`;
    span.onclick=e=>e.preventDefault();
    span.ondblclick=e=>e.preventDefault();
    span.onkeydown=e=>{if(e.key==='Enter'){handleWordClick(word.id);e.preventDefault();}};
    span.append(document.createTextNode(`${word.text} `));
    transcriptPane.append(span); wordElements.set(word.id,span); previous=word;
  }
  function pick(ids) {
    reviewPicked=new Set(ids);
    for(const [id,e] of wordElements) e.classList.toggle('picked',reviewPicked.has(id));
    const label=`${keepers.size} kept · ${reviewPicked.size} selected`;
    if(count.textContent!==label)count.textContent=label;
    buttons.forEach(b=>b.disabled=!reviewPicked.size);
  }
  function focusSentence(id,scrollTranscript) {
    reviewFocus=id;
    for(const [key,e] of scriptElements) e.classList.toggle('focused',key===id);
    const range=ranges.get(id);
    if(scrollTranscript) {
      const wordId=range?.wordIds.find(w=>keepers.has(w))??range?.wordIds[0];
      const el=wordElements.get(wordId);
      if(el) transcriptPane.scrollTop+=el.getBoundingClientRect().top-transcriptPane.getBoundingClientRect().top-transcriptPane.clientHeight/2;
    }
    detail.replaceChildren();
    const choice=choices.get(id); if(!choice)return;
    const label=make('label',null,'Take for this sentence ');
    const select=make('select'); select.setAttribute('aria-label','Take for selected script sentence');
    const auto=make('option',null,'Suggested take');auto.value='auto';select.append(auto);
    const omit=make('option',null,'Omit sentence');omit.value='omit';select.append(omit);
    for(const c of choice.candidates) {const option=make('option',null,`${c.id} · ${(c.startMs/1000).toFixed(2)}s`);option.value=c.id;select.append(option);}
    const decision=project.review.decisions[id]; select.value=decision?.action==='reject'?'omit':decision?.candidateId??'auto';
    select.onchange=()=>send({type:'sentence',sentenceId:id,action:select.value==='auto'?'clear':select.value==='omit'?'reject':'approve',candidateId:select.value});
    label.append(select); detail.append(label,make('span',null,choice.flags.includes('spoken-addition-preserved')?'Spoken addition kept with this sentence.':''));
  }
  scriptPane.onscroll=()=>{
    const rect=scriptPane.getBoundingClientRect();const center=rect.top+scriptPane.clientHeight/2;
    let nearest=null,distance=Infinity;
    for(const [id,e] of scriptElements) {const r=e.getBoundingClientRect();const d=Math.abs((r.top+r.bottom)/2-center);if(d<distance){nearest=id;distance=d;}}
    if(nearest && nearest!==reviewFocus) focusSentence(nearest,true);
  };
  // No recording-scroll listener: browsing rejected takes must not move script.
  const wordOrder=[...wordElements.keys()],wordIndex=new Map(wordOrder.map((id,index)=>[id,index]));
  let drag=null;
  function nearestWord(clientX,clientY) {
    const direct=document.elementFromPoint(clientX,clientY)?.closest?.('.record-word');
    if(direct&&transcriptPane.contains(direct))return direct.dataset.wordId;
    const pane=transcriptPane.getBoundingClientRect();
    if(clientX<pane.left||clientX>pane.right||clientY<pane.top||clientY>pane.bottom)return null;
    let best=null,distance=Infinity;
    for(const [id,element] of wordElements) {
      const rect=element.getBoundingClientRect();
      if(rect.bottom<pane.top||rect.top>pane.bottom)continue;
      const dx=clientX<rect.left?rect.left-clientX:clientX>rect.right?clientX-rect.right:0;
      const dy=clientY<rect.top?rect.top-clientY:clientY>rect.bottom?clientY-rect.bottom:0;
      const candidate=dx*dx+dy*dy*4;
      if(candidate<distance){best=id;distance=candidate;}
    }
    return best;
  }
  function dragIds(first,last) {
    const a=wordIndex.get(first),b=wordIndex.get(last);
    if(a===undefined||b===undefined)return[];
    return wordOrder.slice(Math.min(a,b),Math.max(a,b)+1);
  }
  function paintDrag(ids) {
    const toggled=new Set(ids);
    const target=drag?.mode==='keep';
    for(const [id,element] of wordElements)element.classList.toggle('keeper',toggled.has(id)?target:keepers.has(id));
    const predicted=[...wordElements].filter(([id])=>toggled.has(id)?target:keepers.has(id)).length;
    count.textContent=`${predicted} kept · ${ids.length} ${target?'keeping':'removing'}`;
  }
  function restoreDrag() {
    for(const [id,element] of wordElements)element.classList.toggle('keeper',keepers.has(id));
    pick([...reviewPicked]);
  }
  function handleWordClick(id) {
    const element=wordElements.get(id),word=words.get(id);if(!element||!word)return;
    window.getSelection()?.removeAllRanges();
    const pending=pendingWordClicks.get(id);
    if(pending) {
      clearTimeout(pending);
      pendingWordClicks.delete(id);
      element.classList.toggle('keeper',keepers.has(id));
      const sentenceId=element.dataset.sentenceId;
      const change=sentenceId ? send({type:'sentenceToggle',sentenceId}) : send({type:'toggleWords',wordIds:[id]});
      if(sentenceId)focusSentence(sentenceId,false);
      Promise.resolve(change).then(()=>onSeek?.(word));
      return;
    }
    element.classList.toggle('keeper',!keepers.has(id));
    const timer=setTimeout(()=>{
      pendingWordClicks.delete(id);
      const sentenceId=element.dataset.sentenceId;
      const change=send({type:'toggleWords',wordIds:[id]});
      if(sentenceId)focusSentence(sentenceId,false);
      Promise.resolve(change).then(()=>onSeek?.(word));
    },doubleClickWindowMs);
    pendingWordClicks.set(id,timer);
  }
  const pointerdown=event=>{
    if(event.button!==0||event.target.closest('.pane-title'))return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    const id=nearestWord(event.clientX,event.clientY);if(!id)return;
    const direct=event.target.closest?.('.record-word');
    drag={pointerId:event.pointerId,first:id,last:id,clickedId:direct?.dataset.wordId??null,mode:keepers.has(id)?'remove':'keep',x:event.clientX,y:event.clientY,moved:false,ids:[]};
    if(event.isTrusted&&transcriptPane.setPointerCapture)transcriptPane.setPointerCapture(event.pointerId);
  };
  const pointermove=event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const id=nearestWord(event.clientX,event.clientY);if(!id)return;
    const moved=Math.hypot(event.clientX-drag.x,event.clientY-drag.y)>3||id!==drag.first;
    if(!moved&&!drag.moved)return;
    event.preventDefault();drag.moved=true;drag.last=id;
    const ids=dragIds(drag.first,drag.last);
    if(ids.join('\0')!==drag.ids.join('\0')){drag.ids=ids;paintDrag(ids);}
    window.getSelection()?.removeAllRanges();
  };
  const pointerup=event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const completed=drag;drag=null;
    if(event.isTrusted&&transcriptPane.hasPointerCapture?.(event.pointerId))transcriptPane.releasePointerCapture(event.pointerId);
    if(!completed.moved) {event.preventDefault();if(completed.clickedId)handleWordClick(completed.clickedId);return;}
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    if(completed.ids.length)send({type:'words',action:completed.mode,wordIds:completed.ids});else restoreDrag();
  };
  const pointercancel=event=>{if(drag&&event.pointerId===drag.pointerId){drag=null;restoreDrag();if(event.isTrusted&&transcriptPane.hasPointerCapture?.(event.pointerId))transcriptPane.releasePointerCapture(event.pointerId);}};
  const keydown=e=>{
    if(e.target.closest('input,textarea,select') || !shell.contains(e.target))return;
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z') {e.preventDefault();if(e.shiftKey?review.canRedo:review.canUndo)send({type:e.shiftKey?'redo':'undo'});}
    else if(reviewPicked.size && (e.key==='Delete'||e.key==='Backspace'||e.key.toLowerCase()==='k') && !e.metaKey && !e.ctrlKey) {e.preventDefault();send({type:'words',action:e.key.toLowerCase()==='k'?'keep':'remove',wordIds:[...reviewPicked]});}
  };
  transcriptPane.addEventListener('pointerdown',pointerdown);transcriptPane.addEventListener('pointermove',pointermove);transcriptPane.addEventListener('pointerup',pointerup);transcriptPane.addEventListener('pointercancel',pointercancel);
  shell.addEventListener('keydown',keydown);
  disposeReview=()=>{transcriptPane.removeEventListener('pointerdown',pointerdown);transcriptPane.removeEventListener('pointermove',pointermove);transcriptPane.removeEventListener('pointerup',pointerup);transcriptPane.removeEventListener('pointercancel',pointercancel);shell.removeEventListener('keydown',keydown);};
  content.append(scriptPane,transcriptPane);shell.replaceChildren(toolbar,help,detail,content);
  pick([...reviewPicked]); if(reviewFocus)focusSentence(reviewFocus,false);
  if(oldProject===project.id) {scriptPane.scrollTop=oldScroll[0]??0;transcriptPane.scrollTop=oldScroll[1]??0;}
  return { selectWord(id) {
    const element=wordElements.get(id); if(!element)return;
    window.getSelection()?.removeAllRanges();pick([id]);
    const sentenceId=element.dataset.sentenceId;if(sentenceId)focusSentence(sentenceId,false);
    transcriptPane.scrollTop+=element.getBoundingClientRect().top-transcriptPane.getBoundingClientRect().top-transcriptPane.clientHeight/2;
    shell.scrollIntoView({block:'start'});
  }};
}
