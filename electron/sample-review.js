const sample = window.sampleEdit;
const video = document.querySelector('video');
const status = document.querySelector('#status');
const wordElements = [];
const seconds = frame => frame * sample.timeline.fps.denominator / sample.timeline.fps.numerator;
sample.joins.forEach((join, i) => {
  const button = document.createElement('button');
  button.textContent = `Replay join ${i + 1} · ${join.sequenceSeconds.toFixed(2)}s`;
  button.addEventListener('click', async () => {
    video.currentTime = Math.max(0, join.sequenceSeconds - 2);
    try { await video.play(); } catch { status.textContent = 'Press play to review this join.'; }
  });
  document.querySelector('#joins').append(button);
});
sample.sections.forEach((section, i) => {
  const block = document.createElement('div'); block.className = 'section';
  const clip = sample.timeline.intervals[i];
  section.words.forEach(word => {
    const element = document.createElement('span');
    element.className = `word${word.needsReview ? ' uncertain' : ''}`;
    element.textContent = word.text.toLowerCase();
    const start = seconds(clip.start) + word.startMs / 1000 - seconds(clip.inFrame);
    const end = seconds(clip.start) + word.endMs / 1000 - seconds(clip.inFrame);
    element.title = `Source ${(word.startMs / 1000).toFixed(2)}s · alignment score ${word.alignmentScore.toFixed(2)}`;
    element.tabIndex = 0;
    const seek = () => { video.currentTime = Math.max(0, start - 0.1); };
    element.addEventListener('click', seek);
    element.addEventListener('keydown', event => { if (event.key === 'Enter') seek(); });
    block.append(element, document.createTextNode(' '));
    wordElements.push({ element, start, end });
  });
  document.querySelector('#transcript').append(block);
});
video.addEventListener('loadedmetadata', () => { status.textContent = `${video.duration.toFixed(2)} seconds · ${sample.timeline.intervals.length} clips · 23.976 fps · original channel 1`; });
video.addEventListener('error', () => { status.textContent = 'Preview unavailable. Run npm run sample:build to create it.'; });
const update = () => { for (const word of wordElements) word.element.classList.toggle('active', video.currentTime >= word.start && video.currentTime < word.end); };
video.addEventListener('timeupdate', update);
video.addEventListener('seeked', update);
