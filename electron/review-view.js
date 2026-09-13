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
  const help=make('p','review-help','Green words are exported. Drag to toggle a range. Single click applies the sentence majority; double click toggles only that word. Each uninterrupted green passage is one continuous clip.');
  const detail=make('div','review-context');
  const content=make('div','diff');
  const scriptPane=make('div','pane script'); scriptPane.tabIndex=0; scriptPane.setAttribute('aria-label','Original script');
  const transcriptPane=make('div','pane recording'); transcriptPane.tabIndex=0; transcriptPane.setAttribute('aria-label','Recording transcript');
  scriptPane.append(make('div','pane-title','Original script'));
  transcriptPane.append(make('div','pane-title','Recording transcript · green = kept'));
  const scriptText=make('div','script-original'); scriptPane.append(scriptText);
  const scriptElements=new Map(), wordElements=new Map();
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
    const span=make('span','record-word',word.text); span.dataset.wordId=word.id; span.tabIndex=0;
    if (keepers.has(word.id)) span.classList.add('keeper');
    if (!word.valid || word.needsReview) span.classList.add('uncertain');
    if (review.overrides[word.id]) span.classList.add('manual-word');
    if (review.owners[word.id]||sentenceForWord.get(word.id)) span.dataset.sentenceId=review.owners[word.id]||sentenceForWord.get(word.id);
    span.title=`${(word.startMs/1000).toFixed(2)}–${(word.endMs/1000).toFixed(2)}s${review.overrides[word.id]?' · manual '+review.overrides[word.id]:''}`;
    let clickTimer=null;
    span.onclick=()=>{
      if (!window.getSelection()?.isCollapsed) return;
      clearTimeout(clickTimer);
      clickTimer=setTimeout(()=>{
        const sentenceId=span.dataset.sentenceId;
        if(sentenceId) send({type:'sentenceToggle',sentenceId});
        else send({type:'toggleWords',wordIds:[word.id]});
        if(sentenceId) focusSentence(sentenceId,false); onSeek?.(word);
      },220);
    };
    span.ondblclick=()=>{
      clearTimeout(clickTimer); window.getSelection()?.removeAllRanges();
      send({type:'toggleWords',wordIds:[word.id]}); onSeek?.(word);
    };
    span.onkeydown=e=>{if(e.key==='Enter'){span.click();e.preventDefault();}};
    transcriptPane.append(span,document.createTextNode(' ')); wordElements.set(word.id,span); previous=word;
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
  function captureSelection() {
    const selection=window.getSelection(); if(!selection?.rangeCount || selection.isCollapsed)return;
    const range=selection.getRangeAt(0);
    if(transcriptPane.contains(range.startContainer)&&transcriptPane.contains(range.endContainer)) {
      const ids=[...wordElements].filter(([,e])=>range.intersectsNode(e)).map(([id])=>id);
      if(ids.length) { send({type:'toggleWords',wordIds:ids}); selection.removeAllRanges(); }
    }
    else if(scriptText.contains(range.startContainer)&&scriptText.contains(range.endContainer)) {
      const ids=[...scriptElements].filter(([,e])=>range.intersectsNode(e)).map(([id])=>id);
      pick(ids.flatMap(id=>ranges.get(id)?.wordIds.filter(w=>keepers.has(w))??[]));
      if(ids.length && ids[0]!==reviewFocus)focusSentence(ids[0],true);
    }
  }
  const keydown=e=>{
    if(e.target.closest('input,textarea,select') || !shell.contains(e.target))return;
    if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='z') {e.preventDefault();if(e.shiftKey?review.canRedo:review.canUndo)send({type:e.shiftKey?'redo':'undo'});}
    else if(reviewPicked.size && (e.key==='Delete'||e.key==='Backspace'||e.key.toLowerCase()==='k') && !e.metaKey && !e.ctrlKey) {e.preventDefault();send({type:'words',action:e.key.toLowerCase()==='k'?'keep':'remove',wordIds:[...reviewPicked]});}
  };
  shell.addEventListener('pointerup',captureSelection);shell.addEventListener('keyup',captureSelection);shell.addEventListener('keydown',keydown);
  disposeReview=()=>{shell.removeEventListener('pointerup',captureSelection);shell.removeEventListener('keyup',captureSelection);shell.removeEventListener('keydown',keydown);};
  content.append(scriptPane,transcriptPane);shell.replaceChildren(toolbar,help,detail,content);
  pick([...reviewPicked]); if(reviewFocus)focusSentence(reviewFocus,false);
  if(oldProject===project.id) {scriptPane.scrollTop=oldScroll[0]??0;transcriptPane.scrollTop=oldScroll[1]??0;}
  return { selectWord(id) {
    const element=wordElements.get(id); if(!element)return;
    window.getSelection()?.removeAllRanges(); element.click();
    transcriptPane.scrollTop+=element.getBoundingClientRect().top-transcriptPane.getBoundingClientRect().top-transcriptPane.clientHeight/2;
    shell.scrollIntoView({block:'start'});
  }};
}
