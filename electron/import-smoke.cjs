// Uses only the generated test/sync-media fixture, never production media.
module.exports = async window => window.webContents.executeJavaScript(`(async () => {
  const waitFor = async test => {
    const deadline = Date.now() + 30000;
    while (!await test()) {
      if (Date.now() > deadline) throw new Error('Import smoke timed out: ' + document.getElementById('status').textContent);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  };
  await waitFor(() => typeof state !== 'undefined' && state?.project);
  if (state.project.name !== 'Sync integration fixture') throw new Error('Import smoke requires the generated sync fixture');
  const script = document.getElementById('script-text');
  script.value = 'An editable script for synchronization.'; script.dispatchEvent(new Event('input'));
  document.getElementById('synchronize').click();
  await waitFor(async () => Boolean((await window.projects.command('get')).project.synchronization));
  await waitFor(() => !document.getElementById('sync-review').disabled);
  const value = await window.projects.command('get');
  if (value.project.synchronization.issues.length) throw new Error(JSON.stringify(value.project.synchronization.issues));
  if (value.project.synchronization.accepted) throw new Error('Synchronization was accepted without Continue');
  if (document.getElementById('continue-edit').disabled) throw new Error('Continue requires an unnecessary review');
  document.getElementById('sync-review').click();
  if (!document.getElementById('sync-dialog').open || document.querySelectorAll('.sync-lane').length !== 5) throw new Error('Sync review did not display all recordings');
  const result = { recordings: value.project.media.length, matches: value.project.synchronization.matches.length,
    scriptSaved: value.project.script.original === script.value, optionalReview: true,
    noPageScroll: document.documentElement.scrollHeight <= innerHeight + 1,
    noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth + 1 };
  if (!result.scriptSaved || !result.noPageScroll || !result.noHorizontalOverflow) throw new Error(JSON.stringify(result));
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return result;
})()`);
