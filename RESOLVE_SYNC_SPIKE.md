# DaVinci Resolve Free synchronization spike

This experiment tests DaVinci Resolve Free as a synchronization and timeline host before MythiCut changes its project format. It is deliberately separate from the production auto-edit project: it creates a new disposable Resolve project, imports generated media, synchronizes external audio by waveform, builds edited timelines from source-frame ranges, and saves the Resolve project.

The experiment does not modify original recordings or an existing Resolve project. Its generated fixtures and result logs live under ignored `artifacts/resolve-sync/`.

## Why build an edited timeline first

Successful media-pool synchronization alone does not prove the workflow MythiCut needs. A source-range edit checks that Resolve carries the synchronized external audio into timeline clips after cuts. Keeping this as a spike also gives a rollback boundary: MythiCut's versioned JSON and FCP7 XML export remain unchanged until the live Resolve result is accepted.

## Current boundary

- MythiCut talks directly to the bridge's loopback HTTP endpoint for this experiment; the MCP proxy is not required for the spike runner.
- The upstream bridge remains unrestricted and unauthenticated, per the current user decision. Any process on the machine that can reach `127.0.0.1:8787` can invoke every action exposed by the running bridge. Start it only while using Resolve and stop it afterward.
- MythiCut adds `auto_sync_audio` and `append_clip_ranges` to the cloned bridge with an idempotent source patch. Existing bridge actions are left intact.
- Sync results are automatic suggestions. The generated result remains `provisional-awaiting-human-review` until the user checks the synchronized timeline in Resolve.
- No MythiCut project, storage, or portability format changes in this spike.

The bridge was developed against Airta-Admin/Davinc-Resolve-Local-Bridge-MCP commit `3aafa84fc0d39901cb0dcdb09c9c0f2dc84a767b`. DaVinci Resolve 19.1 added `MediaPool.AutoSyncAudio`; this spike targets a current Resolve Free build on Windows.

## Local prerequisites

These are external, ignored dependencies and do not travel with Git:

- DaVinci Resolve Free 19.1 or newer.
- A local clone of [Davinc-Resolve-Local-Bridge-MCP](https://github.com/Airta-Admin/Davinc-Resolve-Local-Bridge-MCP).
- Python and the bridge requirements when using its MCP proxy.
- FFmpeg at `.local/tools/ffmpeg/bin/ffmpeg.exe`, or `MYTHICUT_FFMPEG` set to another executable.

The relevant Resolve API addition is documented in Blackmagic Design's [DaVinci Resolve 19.1 New Features Guide](https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_19_1_New_Features_Guide.pdf).

## Setup

From the repository root in PowerShell:

```powershell
git clone https://github.com/Airta-Admin/Davinc-Resolve-Local-Bridge-MCP .local/resolve-bridge
git -C .local/resolve-bridge checkout 3aafa84fc0d39901cb0dcdb09c9c0f2dc84a767b
npm run resolve:bridge:patch -- .local/resolve-bridge/bridge/Bridge-Connection-Script.py
python .local/resolve-bridge/install.py
```

Restart Resolve after installing the bridge. In Resolve, open **Workspace > Workflow Integrations > DaVinci Resolve Local Bridge MCP Server Connection**, click **Start Bridge**, and verify that it reports `http://127.0.0.1:8787`.

The install helper writes outside the repository into the user's Resolve scripts folder and, when available, the machine-wide Workflow Integration Plugins folder. Existing installed bridge files are timestamp-backed-up by the helper.

## Run the proof

```powershell
npm run resolve:fixtures
npm run resolve:sync-spike
```

The runner requires the bridge actions `create_project`, `import_media`, `auto_sync_audio`, `create_timeline`, `append_clip_ranges`, and `save_project`. It then:

1. Creates a uniquely named Resolve project.
2. Imports the short and long camera/recorder pairs.
3. Replaces each camera clip's embedded audio association with the waveform-synchronized recorder clip while retaining video metadata.
4. Creates **Short Sync Edited** with two non-contiguous source ranges.
5. Creates **Long Drift Check** with one range near the start and one near the ten-minute end.
6. Saves the project and writes `artifacts/resolve-sync/resolve-result.json`.

## Deterministic fixtures

The fixtures use seeded pink noise so waveform alignment can be tested without production media:

| Pair | Expected initial offset | Clock behavior | Timeline samples |
| --- | ---: | --- | --- |
| Short clap-sync recording | 1.5 seconds / 45 frames at 30 fps | Same 48 kHz clock; deterministic clap-like transient followed by shared seeded waveform | Two edited ranges within 12 seconds |
| Long drift recording | 1.5 seconds / 45 frames at 30 fps | Recorder simulated at 48,010 Hz against a nominal 48,000 Hz clock, about 208 ppm fast | Start and end ranges separated by about ten minutes |

The long fixture accumulates approximately 0.125 seconds of expected drift over 600 seconds. Resolve waveform auto-sync establishes an alignment point; whether it compensates for rate drift must be observed and recorded from the live result.

## Acceptance checklist

- The bridge reports both MythiCut extension actions.
- Both `auto_sync_audio` calls return `status: ok`.
- **Short Sync Edited** has video and externally synchronized audio on both edited ranges, with the clap/waveform aligned.
- **Long Drift Check** is aligned near the start.
- The end sample is measured for residual drift and the result is recorded; do not infer rate correction from the initial sync succeeding.
- The Resolve project saves and reopens with both timelines intact.
- The user explicitly accepts or rejects the synchronized result before it becomes an input to MythiCut.

Only after this checklist passes should a separate design decide whether MythiCut stores a Resolve project reference, imports Resolve XML/OTIO, or drives Resolve directly for final timeline construction.

## Automated checks

`test/resolve-bridge-patch.test.mjs` verifies that the bridge patch is idempotent and fails closed on an unknown upstream layout. `test/resolve-bridge-client.test.mjs` verifies local action request/error handling. The ignored bridge clone also has a fake-Resolve Python test for the new functions; that test is local setup evidence rather than tracked product code.
