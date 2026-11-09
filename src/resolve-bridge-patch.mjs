export const RESOLVE_BRIDGE_SYNC_EXTENSION = `def _find_media_pool_item(folder, clip_name):
    """Find exactly one media-pool item by name, including nested bins."""
    matches = []

    def visit(current):
        for item in current.GetClipList() or []:
            if item.GetName() == clip_name:
                matches.append(item)
        for child in current.GetSubFolderList() or []:
            visit(child)

    visit(folder)
    if not matches:
        raise ValueError("Media-pool clip '%s' was not found" % clip_name)
    if len(matches) != 1:
        raise ValueError("Media-pool clip name '%s' is ambiguous" % clip_name)
    return matches[0]

def api_auto_sync_audio(videoClipName, audioClipName, method="waveform",
                        channelNumber=-1, retainEmbeddedAudio=False,
                        retainVideoMetadata=True):
    """Sync one external audio clip to one video clip in the media pool."""
    if not resolve:
        _connect()
    proj = project_manager.GetCurrentProject()
    if not proj:
        return {"status": "error", "message": "No project open"}
    method_key = str(method).strip().lower()
    methods = {
        "waveform": resolve.AUDIO_SYNC_WAVEFORM,
        "timecode": resolve.AUDIO_SYNC_TIMECODE,
    }
    if method_key not in methods:
        return {"status": "error", "message": "method must be waveform or timecode"}
    try:
        channel_number = int(channelNumber)
    except (TypeError, ValueError):
        return {"status": "error", "message": "channelNumber must be an integer"}

    media_pool = proj.GetMediaPool()
    root = media_pool.GetRootFolder()
    video = _find_media_pool_item(root, videoClipName)
    audio = _find_media_pool_item(root, audioClipName)
    settings = {
        "audioSyncMethod": methods[method_key],
        "audioSyncChannelNumber": channel_number,
        "retainEmbeddedAudio": bool(retainEmbeddedAudio),
        "retainVideoMetadata": bool(retainVideoMetadata),
    }
    synced = media_pool.AutoSyncAudio([video, audio], settings)
    return {
        "status": "ok" if synced else "error",
        "synced": bool(synced),
        "videoClip": video.GetName(),
        "audioClip": audio.GetName(),
        "method": method_key,
        "channelNumber": channel_number,
        "retainEmbeddedAudio": bool(retainEmbeddedAudio),
        "retainVideoMetadata": bool(retainVideoMetadata),
    }
`;

export const RESOLVE_BRIDGE_RANGE_EXTENSION = `def api_append_clip_ranges(clipName, ranges):
    """Append source-frame ranges from one media-pool clip to the current timeline."""
    if not resolve: _connect()
    proj = project_manager.GetCurrentProject()
    if not proj: return {"status": "error", "message": "No project open"}
    if not isinstance(ranges, list) or not ranges:
        return {"status": "error", "message": "ranges must be a non-empty list"}
    mp = proj.GetMediaPool()
    clip = _find_media_pool_item(mp.GetRootFolder(), clipName)
    clip_info = []
    for index, source_range in enumerate(ranges):
        if not isinstance(source_range, dict):
            return {"status": "error", "message": "range %d must be an object" % index}
        try:
            start = int(source_range["startFrame"])
            end = int(source_range["endFrame"])
        except (KeyError, TypeError, ValueError):
            return {"status": "error", "message": "range %d needs integer startFrame and endFrame" % index}
        if start < 0 or end <= start:
            return {"status": "error", "message": "range %d is invalid" % index}
        info = {"mediaPoolItem": clip, "startFrame": start, "endFrame": end}
        if "recordFrame" in source_range:
            info["recordFrame"] = int(source_range["recordFrame"])
        clip_info.append(info)
    items = mp.AppendToTimeline(clip_info)
    return {
        "status": "ok" if items and len(items) >= len(ranges) else "error",
        "clip": clip.GetName(),
        "rangeCount": len(ranges),
        "items": [item.GetName() for item in items] if items else [],
    }
`;

const SYNC_FUNCTION = 'def api_auto_sync_audio(';
const RANGE_FUNCTION = 'def api_append_clip_ranges(';
const CREATE_TIMELINE_MARKER = 'def api_create_timeline(name, clips=None):';
const CREATE_FROM_CLIPS_MARKER = 'def api_create_timeline_from_clips(name, clipNames):';
const IMPORT_ACTION = '    "import_media": api_import_media,';
const APPEND_ACTION = '    "append_to_timeline": api_append_to_timeline,';

export function patchResolveBridge(source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('Resolve bridge source is empty');
  let next = source;
  let changed = false;

  if (!next.includes(SYNC_FUNCTION)) {
    if (!next.includes(CREATE_TIMELINE_MARKER)) throw new Error('Unsupported bridge: create-timeline marker is missing');
    next = next.replace(CREATE_TIMELINE_MARKER, `${RESOLVE_BRIDGE_SYNC_EXTENSION}\n${CREATE_TIMELINE_MARKER}`);
    changed = true;
  }
  if (!next.includes(RANGE_FUNCTION)) {
    if (!next.includes(CREATE_FROM_CLIPS_MARKER)) throw new Error('Unsupported bridge: create-from-clips marker is missing');
    next = next.replace(CREATE_FROM_CLIPS_MARKER, `${RESOLVE_BRIDGE_RANGE_EXTENSION}\n${CREATE_FROM_CLIPS_MARKER}`);
    changed = true;
  }
  if (!next.includes('"auto_sync_audio": api_auto_sync_audio')) {
    if (!next.includes(IMPORT_ACTION)) throw new Error('Unsupported bridge: import-media action is missing');
    next = next.replace(IMPORT_ACTION, `${IMPORT_ACTION}\n    "auto_sync_audio": api_auto_sync_audio,`);
    changed = true;
  }
  if (!next.includes('"append_clip_ranges": api_append_clip_ranges')) {
    if (!next.includes(APPEND_ACTION)) throw new Error('Unsupported bridge: append action is missing');
    next = next.replace(APPEND_ACTION, `${APPEND_ACTION}\n    "append_clip_ranges": api_append_clip_ranges,`);
    changed = true;
  }
  return { source: next, changed };
}
