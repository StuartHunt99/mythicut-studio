const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = async window => {
  window.show();
  window.focus();
  await wait(200);
  const waitFor = async (check, label) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const value = await check();
      if (value) return value;
      await wait(25);
    }
    throw new Error(`Timeout: ${label}`);
  };
  const target = await waitFor(() => window.webContents.executeJavaScript(`(async()=>{
    const element=document.querySelector('.record-word.keeper');
    if(!element)return null;
    element.scrollIntoView({block:'center'});await new Promise(requestAnimationFrame);
    const rect=element.getBoundingClientRect();const state=await window.projects.command('get');
    const sentenceId=element.dataset.sentenceId;
    const sentenceIds=state.reviewView.ranges.find(range=>range.sentenceId===sentenceId)?.wordIds??[];
    return {id:element.dataset.wordId,sentenceIds,x:Math.round((rect.left+rect.right)/2),y:Math.round((rect.top+rect.bottom)/2),revision:state.reviewView.revision};
  })()`), 'native click target');
  const click = ({ x, y }) => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  click(target);
  await waitFor(() => window.webContents.executeJavaScript(`(async()=>{
    const state=await window.projects.command('get');
    return state.reviewView.revision>${target.revision}&&!state.reviewView.selectedWordIds.includes(${JSON.stringify(target.id)});
  })()`), 'native click removed word');
  const afterFirst = await window.webContents.executeJavaScript(`(()=>{
    const element=document.querySelector('[data-word-id=${JSON.stringify(target.id)}]');
    return {kept:element.classList.contains('keeper'),nativeSelection:window.getSelection()?.toString()??'',userSelect:getComputedStyle(element).userSelect};
  })()`);
  if (afterFirst.kept || afterFirst.nativeSelection || afterFirst.userSelect !== 'none') throw new Error(`Native click did not exclusively toggle green state: ${JSON.stringify(afterFirst)}`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-review-action="undo"]').click()`);
  await waitFor(() => window.webContents.executeJavaScript(`(async()=>{const state=await window.projects.command('get');return state.reviewView.selectedWordIds.includes(${JSON.stringify(target.id)});})()`), 'native click test cleanup');
  const doubleTarget = await window.webContents.executeJavaScript(`(()=>{const element=document.querySelector('[data-word-id=${JSON.stringify(target.id)}]');const rect=element.getBoundingClientRect();return{x:Math.round((rect.left+rect.right)/2),y:Math.round((rect.top+rect.bottom)/2)}})()`);
  const beforeDouble = await window.webContents.executeJavaScript(`window.projects.command('get').then(state=>state.reviewView.revision)`);
  click(doubleTarget); click(doubleTarget);
  const afterDouble = await waitFor(() => window.webContents.executeJavaScript(`(async()=>{const state=await window.projects.command('get');return state.reviewView.revision>${beforeDouble}?state:null;})()`), 'native double click command');
  if (!target.sentenceIds.length || !target.sentenceIds.every(id=>!afterDouble.reviewView.selectedWordIds.includes(id))) throw new Error(`Native double click did not toggle the sentence: ${JSON.stringify({sentenceIds:target.sentenceIds,selected:afterDouble.reviewView.selectedWordIds.includes(target.id),revision:afterDouble.reviewView.revision})}`);
  await window.webContents.executeJavaScript(`document.querySelector('[data-review-action="undo"]').click()`);
  await waitFor(() => window.webContents.executeJavaScript(`(async()=>{const state=await window.projects.command('get');return state.reviewView.selectedWordIds.includes(${JSON.stringify(target.id)});})()`), 'native double click test cleanup');
  window.hide();
  return { wordId: target.id, toggledAndRestored: true, nativeSelectionSuppressed: true };
};
