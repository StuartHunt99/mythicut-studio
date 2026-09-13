import { matchingTokens } from './matching.mjs';
const expansions = { "we're": ['we','are'], "i've": ['i','have'], "i'll": ['i','will'], "it's": ['it','is'], "that's": ['that','is'], "there's": ['there','is'], "wasn't": ['was','not'], "isn't": ['is','not'], "don't": ['do','not'], "can't": ['can','not'], "didn't": ['did','not'], "she's": ['she','is'], "we'll": ['we','will'], "you're": ['you','are'], "he's": ['he','is'], '3': ['three'], '1': ['one'], '40': ['forty'] };
export const speechTokens = text => matchingTokens(text).flatMap(t => expansions[t] ?? [t]);
function editDistance(a,b) {
 let row = Array.from({length:b.length+1},(_,i)=>i);
 for (let i=1;i<=a.length;i++) { const next=[i]; for(let j=1;j<=b.length;j++) next[j]=Math.min(next[j-1]+1,row[j]+1,row[j-1]+(a[i-1]===b[j-1]?0:1)); row=next; } return row[b.length];
}
export function sentenceEvidence(sentences, words, { restartPhrase = '' } = {}) {
 const speech=words.flatMap((w,index)=>speechTokens(w.text).map(text=>({text,index})));
 const memo=new Map();
 const cost=(a,b)=> { if(a===b)return 0; const key=a+'|'+b;if(!memo.has(key)) { const d=editDistance(a,b)/Math.max(a.length,b.length);memo.set(key,d<=.34?.35:1); }return memo.get(key); };
 const evidence = sentences.map((sentence,si)=>{
  const target=speechTokens(sentence.text);const n=speech.length,m=target.length;
  if(!m)return {sentence,scriptIndex:si,candidates:[]};
  const direction=new Uint8Array((m+1)*(n+1));let previous=new Float32Array(n+1);let starts=Uint32Array.from({length:n+1},(_,i)=>i);
  for(let i=1;i<=m;i++) {
   const row=new Float32Array(n+1);row[0]=i;const begin=new Uint32Array(n+1);
   for(let j=1;j<=n;j++) {
    const sub=previous[j-1]+cost(target[i-1],speech[j-1].text),del=previous[j]+1,ins=row[j-1]+1;
    row[j]=Math.min(sub,del,ins);
    const dir=sub<=del&&sub<=ins?1:del<=ins?2:3;direction[i*(n+1)+j]=dir;
    begin[j]=dir===1?starts[j-1]:dir===2?starts[j]:begin[j-1];
   }previous=row;starts=begin;
  }
  const possible=[];
  for(let end=1;end<=n;end++) {
   const start=starts[end],score=1-previous[end]/m;
   if(score<.60||end-start<Math.ceil(m*.55)||end-start>m*1.6+3)continue;
   let i=m,j=end;const pairs=[];
   while(i>0&&j>0) {const d=direction[i*(n+1)+j];if(d===1){pairs.push([i-1,j-1]);i--;j--;}else if(d===2)i--;else j--;}
   const mapped=pairs.filter(([a,b])=>cost(target[a],speech[b].text)<1).reverse();
   if(!mapped.length)continue;
   const first=mapped[0],last=mapped.at(-1);
   const startIndex=speech[start]?.index,endIndex=speech[end-1].index;
   if(startIndex===undefined||words[startIndex].mediaId!==words[endIndex].mediaId)continue;
   const completeEnd=last[0]>=m-2;
   possible.push({scriptIndex:si,mediaId:words[startIndex].mediaId,startIndex,endIndex,score,completeEnd,leadingMissing:first[0],trailingMissing:m-1-last[0],text:words.slice(startIndex,endIndex+1).map(w=>w.text).join(' '),startMs:words[startIndex].startMs,endMs:words[endIndex].endMs});
  }
  const candidates=[];
  for(const c of possible.sort((a,b)=>Number(b.completeEnd)-Number(a.completeEnd)||b.score-a.score||b.endIndex-b.startIndex-(a.endIndex-a.startIndex))) {
   if(!candidates.some(x=>x.startIndex<=c.endIndex&&c.startIndex<=x.endIndex))candidates.push(c);
  }
  return {sentence,scriptIndex:si,candidates:candidates.sort((a,b)=>a.startIndex-b.startIndex).map((c,index)=>({...c,id:`${sentence.id}-take${index+1}`}))};
 });
 preserveSentenceAdditions(evidence, words, restartPhrase);
 return evidence;
}

// Alignment locates a sentence; it is not a word-deletion instruction. Extend
// short unclaimed edges inside the same spoken sentence, never over a restart,
// another candidate, a file edge, or a substantial pause. Interior insertions
// are already included by each candidate's continuous index range.
function preserveSentenceAdditions(evidence, words, restartPhrase) {
 const candidates = evidence.flatMap(e => e.candidates);
 const occupied = new Uint8Array(words.length);
 for (const c of candidates) for (let i=c.startIndex; i<=c.endIndex; i++) occupied[i]=1;
 const endsSentence = w => /[.!?]["”')]*$/.test(w.text);
 const adjacent = (a,b) => a && b && a.mediaId === b.mediaId && b.startMs-a.endMs <= 1200;
 const marker = speechTokens(restartPhrase);
 for (const e of evidence) for (const c of e.candidates) {
  let start=c.startIndex, end=c.endIndex;
  while (start>0 && c.startIndex-start<8 && !occupied[start-1] && !endsSentence(words[start-1]) && !/[-–—]$/.test(words[start-1].text) && adjacent(words[start-1],words[start])) start--;
  const prefix=speechTokens(words.slice(start,c.startIndex).map(w=>w.text).join(' '));
  const target=speechTokens(e.sentence.text);
  // A repeated opening belongs to the abandoned attempt, even when short.
  const candidateOpening=speechTokens(words[c.startIndex].text)[0];
  const repeatedOpening=prefix.includes(candidateOpening);
  const hasMarker=marker.length && prefix.some((_,i)=>marker.every((t,j)=>prefix[i+j]===t));
  if (repeatedOpening || hasMarker) start=c.startIndex;
  if (!endsSentence(words[end])) {
   let tail=end;
   while (tail+1<words.length && tail-end<8 && !occupied[tail+1] && adjacent(words[tail],words[tail+1])) {
    tail++;
    if (endsSentence(words[tail])) break;
   }
   const suffix=speechTokens(words.slice(end+1,tail+1).map(w=>w.text).join(' '));
   const containsMarker=marker.length && suffix.some((_,i)=>marker.every((t,j)=>suffix[i+j]===t));
   if (tail>end && endsSentence(words[tail]) && !containsMarker && !suffix.includes(target[0])) end=tail;
  }
  if (start!==c.startIndex || end!==c.endIndex) {
   c.alignmentStartIndex=c.startIndex; c.alignmentEndIndex=c.endIndex;
   c.startIndex=start; c.endIndex=end; c.startMs=words[start].startMs; c.endMs=words[end].endMs;
   c.text=words.slice(start,end+1).map(w=>w.text).join(' ');
   c.preservedAdditions=true;
  }
 }
}

export function selectLatestTakes(evidence) {
 // Long neighboring script matches constrain short phrases to their local
 // context, preventing "nature of hell" elsewhere from becoming a retake.
 const anchors=evidence.map(e=>speechTokens(e.sentence.text).length>=8?e.candidates.filter(c=>c.score>=.72&&c.completeEnd):[]);
 const choices=evidence.map((e,i)=>{
  let left=i-1,right=i+1;
  while(left>=0&&!anchors[left].length)left--;
  while(right<anchors.length&&!anchors[right].length)right++;
  const floor=left>=0?Math.min(...anchors[left].map(c=>c.startIndex)):-1;
  const ceiling=right<anchors.length?Math.max(...anchors[right].map(c=>c.endIndex)):Infinity;
  const candidates=e.candidates.filter(c=>c.startIndex>=floor&&c.endIndex<=ceiling&&c.completeEnd&&c.leadingMissing<=Math.max(2,speechTokens(e.sentence.text).length*.2));
  const selected=candidates.at(-1)??null;
  return {...e,eligibleCandidateIds:candidates.map(c=>c.id),selectedCandidateId:selected?.id??null,selected,flags:[...(!selected?['unmatched-or-omitted']:selected.score<.8||candidates.length>1?['llm-review']:[]), ...(selected?.preservedAdditions?['spoken-addition-preserved']:[])]};
 });
 // Drop an older sentence only when a later restart demonstrably passes it.
 // If the later attempt simply ends, retain the older ending for recovery.
 for(let i=1;i<choices.length-1;i++) {
  const c=choices[i];if(!c.selected)continue;
  let left=i-1,right=i+1;
  while(left>=0&&!choices[left].selected)left--;
  while(right<choices.length&&!choices[right].selected)right++;
  if(left<0||right>=choices.length)continue;
  const before=choices[left].selected,after=choices[right].selected;
  if(before.startIndex>c.selected.endIndex&&after.startIndex>before.endIndex) {c.flags.push('superseded-by-later-omission');c.selected=null;c.selectedCandidateId=null;}
 }
 // Preserve source order within a selected sentence; overlapping matches cannot
 // silently duplicate speech across adjacent script sentences.
 let previous=null;
 for(const choice of choices) {
  if(!choice.selected)continue;
  if(previous&&choice.selected.startIndex<=previous.selected.endIndex&&choice.selected.endIndex>=previous.selected.startIndex) choice.flags.push('overlapping-candidates');
  if(previous&&choice.selected.endIndex<previous.selected.startIndex) choice.flags.push('recovered-earlier-ending');
  previous=choice;
 }
 return choices;
}
