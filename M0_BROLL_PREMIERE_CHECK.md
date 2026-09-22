# M0 B-roll Premiere import check

Status: the corrected synthetic fixture imported into Adobe Premiere Pro 2026 on Windows on 2026-09-21. Direct stills, track stacking, visible fill-frame motion, and editable Position/Scale keyframes were observed. This is an interchange experiment, not the production exporter or full M0 acceptance.

## Generate the isolated fixture

Run `npm run m0:broll`. The command creates a new, uniquely named directory under ignored `artifacts/` and prints its path. It never overwrites or deletes original recordings or artwork. Open `m0-broll-premiere.xml` from that directory in Adobe Premiere Pro using File > Import. Keep all generated images and `continuous-tone.wav` in the same directory during the check.

The fixture uses diagnostic stills and a generated WAV rather than a phase-1 source video. This isolates still-image interchange and motion without requiring a production recording or an unavailable `ffmpeg` installation. Source-video/audio integration remains a separate M7 gate.

## Expected timeline

| Track | Interval (30 fps) | Expected content |
| --- | --- | --- |
| V1 | frames 0–180, 180–360 | Two contiguous blue-gray host-placeholder stills |
| V2 | 0–120 | Blue landscape, zoom in from 75% to 90% and shift toward the subject |
| V2 | 120–240 | Purple portrait, zoom out from 190% to 160% |
| V2 | 240–360 | Green landscape, pan right at 90% scale |
| V3 | 180–240 only | Orange sparse override above the final two seconds of the purple V2 clip |
| A1 | 0–360 | Continuous 440 Hz tone |

The sequence is 1920×1080, 30 fps, and 360 frames (12 seconds). All transitions are hard cuts. V2 must remain present below V3; the replacement must not duplicate the whole V2 track.

## Manual verification checklist

- [x] Import completed without a visible missing-media, unsupported-effect, or translation warning for the corrected fixture.
- [x] Sequence reports 1920×1080, 30.00p, and 12 seconds.
- [x] V1/V2/V3/A1 layout and the intended hard-cut boundaries are visible in the timeline. Exact boundary tooltips were checked for the first V2 clip (0–3:29).
- [x] Direct PNG stills remain separately selectable in the project/timeline; no animation was pre-rendered into video.
- [x] Premiere Properties shows native, editable Position and Scale keyframes on the inspected V2 clips; the V3 override was visibly animated but its controls were not separately inspected.
- [x] The blue clip zooms in, the purple clip visually fills the frame while zooming out, and the green clip pans right without exposing the host layer at inspected frames.
- [x] At 6:22 the orange V3 image is visible while the purple V2 interval remains underneath.
- [x] The user auditioned and confirmed continuous A1 audio.
- [x] A generated still was made offline and relinked through Premiere's normal Link Media UI; the image and editable motion returned.

### Import notes, 2026-09-21

The first generated fixture imported but its `center` endpoint `x=-5` was interpreted as five *source widths*, moving a 2560px still approximately 12,800px off-screen. FCP7 XML center coordinates are fractions of source dimensions, not percentages. The generator now uses `x=-0.05` for a five-percent-of-source-width shift and rejects magnitudes above 1. The corrected fixture is in ignored `artifacts/m0-broll-unrRiw/`; its `MythiCut M0 B-roll motion fixture v2` sequence was imported into and saved in the isolated `artifacts/m0-broll-PSKXBi/MythiCut_M0_Broll_Import_Check.prproj`. The original failed sequence remains in that isolated project for comparison.

At frame 0, the first V2 still showed 75% scale and centered Position 960×540. At 3:08, Premiere showed 87% scale and Position 855.5×540, with artwork still covering the output. At 5:12, the purple portrait covered the output; at 6:22, the orange V3 override was visible. On the pan, Premiere showed Position 953.6×540 at 9:27 and 1053.9×540 at 11:14, with 90% scale and artwork covering the frame. Blue Position/Scale keyframe indicators were visible in Properties. `npm test` passed 70 tests after the coordinate correction.

This synthetic fixture did not use a real phase-1 source video, actual catalog artwork or detection boxes. The user confirmed the continuous audio, and a direct still relink succeeded. An attempted repeat-import/source-identity check was interrupted; the user explicitly asked to stop and assume it passed. That result is therefore an assumption, not a verified Premiere finding. Source-video/audio integration remains the later M7 gate.

## Source references

- [Apple FCP7 XML Elements Catalog](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html) defines `stillframe`, `keyframe`, `when`, and motion-center values.
- [Apple FCP7 XML encoding guide](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Basics/Basics.html) describes effect-parameter keyframes.
- [Adobe Premiere reference](https://helpx.adobe.com/pdf/cs6/premiere_pro_reference.pdf) states that FCP7 Basic Motion and motion keyframes can transfer. This does not replace testing the current installation.
