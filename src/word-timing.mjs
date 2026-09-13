import { createHash } from 'node:crypto';
import { sentenceEvidence, speechTokens } from './take-selection.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const timingInputId = words => hash(words.map(w=>[w.id,w.mediaId,w.text,w.startMs,w.endMs]));
const tokens = text => speechTokens(text);
// Source-time evidence supplements recognition; it never changes recognized
// text, word IDs, candidate IDs, or the user's keep/remove decisions.
export function refineWordTiming(words, acousticWords, { mediaId, sourceIdentity } = {}) {
  const source = words.filter(w=>w.mediaId===mediaId);
  const acoustic=acousticWords.filter(w=>!w.mediaId||w.mediaId===mediaId).map(w=>({...w,mediaId}));
  const units=[];
  for(const word of source) {
    const unit=units.at(-1),previous=unit?.at(-1);
    if(!previous || /[.!?][-"”')]*$/.test(previous.text) || /[-–—]$/.test(previous.text) || word.startMs-previous.endMs>2500) units.push([word]);
    else unit.push(word);
  }
  const refined={};const unresolved=[];let floor=0;
  for(const unit of units) {
    const first=unit[0],last=unit.at(-1);
    const lower=Math.max(floor,first.startMs-3000),upper=last.endMs+3000;
    const nearby=acoustic.filter(w=>w.endMs>=lower && w.startMs<=upper);
    if(!nearby.length){unresolved.push(...unit.map(w=>w.id));continue;}
    const text=unit.map(w=>w.text).join(' ');
    const evidence=sentenceEvidence([{id:'timing',text}],nearby)[0];
    const candidates=evidence.candidates.filter(c=>c.score>=.78 && c.leadingMissing===0 && c.trailingMissing===0);
    const cost=c=>Math.abs(c.startMs-first.startMs)+Math.abs(c.endMs-last.endMs);
    candidates.sort((a,b)=>b.score-a.score || cost(a)-cost(b) || b.startIndex-a.startIndex);
    const chosen=candidates[0];
    if(!chosen){unresolved.push(...unit.map(w=>w.id));continue;}
    const segment=nearby.slice(chosen.alignmentStartIndex??chosen.startIndex,(chosen.alignmentEndIndex??chosen.endIndex)+1);
    const pairs=alignedTokens(unit,segment);
    for(const word of unit) {
      const matches=pairs.filter(p=>p.wordId===word.id);
      const target=tokens(word.text);
      if(!target.length || matches.length!==target.length){unresolved.push(word.id);continue;}
      const spoken=[...new Set(matches.map(p=>p.acousticIndex))].map(i=>segment[i]);
      const startMs=spoken[0].startMs,endMs=spoken.at(-1).endMs;
      const confidence=Math.min(...spoken.map(w=>w.acousticConfidence??0));
      const valid=Number.isFinite(startMs)&&Number.isFinite(endMs)&&endMs>startMs&&endMs-startMs<=2500;
      if(!valid || confidence<.65 || spoken.some(w=>w.needsReview)){unresolved.push(word.id);continue;}
      refined[word.id]={startMs,endMs,valid:true,needsReview:false,confidence,method:'independent-acoustic-match',acousticWordIds:spoken.map(w=>w.id)};
    }
    floor=Math.max(floor,segment.at(-1)?.endMs??0);
  }
  // A proper name or contraction can make a whole sentence a poor match.
  // Recover exact local word matches only with neighboring lexical context,
  // staying between already established timing anchors.
  for(let i=0;i<source.length;i++) {
    const word=source[i];if(refined[word.id])continue;
    const window=source.slice(Math.max(0,i-2),i+3);
    const left=source.slice(Math.max(0,i-5),i).reverse().find(w=>refined[w.id]);
    const right=source.slice(i+1,i+6).find(w=>refined[w.id]);
    const nearby=acoustic.filter(w=>w.endMs>=window[0].startMs-3000 && w.startMs<=window.at(-1).endMs+3000);
    const evidence=sentenceEvidence([{id:'local',text:window.map(w=>w.text).join(' ')}],nearby)[0];
    const candidates=evidence.candidates.filter(c=>c.score>=.78).sort((a,b)=>b.score-a.score||Math.abs(a.startMs-window[0].startMs)-Math.abs(b.startMs-window[0].startMs));
    for(const c of candidates) {
      const segment=nearby.slice(c.alignmentStartIndex??c.startIndex,(c.alignmentEndIndex??c.endIndex)+1);
      const pairs=alignedTokens(window,segment),matched=pairs.filter(p=>p.wordId===word.id);
      if(pairs.length<3 || matched.length!==tokens(word.text).length || !matched.length)continue;
      const spoken=[...new Set(matched.map(p=>p.acousticIndex))].map(j=>segment[j]);
      const startMs=spoken[0].startMs,endMs=spoken.at(-1).endMs,confidence=Math.min(...spoken.map(w=>w.acousticConfidence??0));
      if(startMs<0||endMs<=startMs||endMs-startMs>2500||confidence<.65||spoken.some(w=>w.needsReview))continue;
      if(left && startMs<refined[left.id].endMs || right && endMs>refined[right.id].startMs)continue;
      refined[word.id]={startMs,endMs,valid:true,needsReview:false,confidence,method:'independent-acoustic-context',acousticWordIds:spoken.map(w=>w.id)};break;
    }
  }
  const content={schemaVersion:1,mediaId,sourceIdentity,inputId:timingInputId(words),words:refined,unresolvedWordIds:source.filter(w=>!refined[w.id]).map(w=>w.id)};
  return {...content,id:hash(content)};
}
function alignedTokens(words,acoustic) {
  const a=words.flatMap(w=>tokens(w.text).map(text=>({text,wordId:w.id})));
  const b=acoustic.flatMap((w,i)=>tokens(w.text).map(text=>({text,acousticIndex:i})));
  const columns=b.length+1, directions=new Uint8Array((a.length+1)*columns);
  let previous=Float64Array.from({length:columns},(_,i)=>i);
  for(let i=1;i<=a.length;i++) {
    const row=new Float64Array(columns);row[0]=i;
    for(let j=1;j<=b.length;j++) {
      const sub=previous[j-1]+(a[i-1].text===b[j-1].text?0:2),del=previous[j]+1,ins=row[j-1]+1;
      const dir=sub<=del&&sub<=ins?1:del<=ins?2:3;
      row[j]=Math.min(sub,del,ins);directions[i*columns+j]=dir;
    }
    previous=row;
  }
  const pairs=[];let i=a.length,j=b.length;
  while(i&&j) {
    const dir=directions[i*columns+j];
    if(dir===1){if(a[i-1].text===b[j-1].text)pairs.push({...a[i-1],acousticIndex:b[j-1].acousticIndex});i--;j--;}
    else if(dir===2)i--;else j--;
  }
  return pairs.reverse();
}
export function timedWords(result) {
  const refinements=result.timing??[];
  const identity=timingInputId(result.words);
  if(!Array.isArray(refinements)||refinements.some(r=>r.inputId!==identity))throw new Error('Stale word timing evidence');
  const refinedSources=new Set(refinements.map(r=>r.mediaId));
  const byId=new Map(result.words.map(w=>[w.id,refinedSources.has(w.mediaId)?{...w,needsReview:true}:w]));const used=new Set();
  for(const r of refinements)for(const [id,timing] of Object.entries(r.words)) {
    const word=byId.get(id);
    if(!word || word.mediaId!==r.mediaId || used.has(id) || timing.valid!==true || !Number.isFinite(timing.startMs)||!Number.isFinite(timing.endMs)||timing.startMs<0||timing.endMs<=timing.startMs)throw new Error('Invalid word timing evidence');
    used.add(id);byId.set(id,{...word,...timing,id:word.id,mediaId:word.mediaId,text:word.text});
  }
  return result.words.map(w=>byId.get(w.id));
}
export const timingRevision = result => hash(timedWords(result).map(w=>[w.id,w.startMs,w.endMs,w.needsReview??false]));
