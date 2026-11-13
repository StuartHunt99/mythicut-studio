# Synchronization dependencies

The synchronization engine in `src/sync/` is MythiCut application code. It uses FFT.js 4.0.4 for Fourier transforms. No BBC, Audalign, SynAudio, or Resolve bridge code is embedded in this engine.

## FFT.js 4.0.4

Source: https://github.com/indutny/fft.js

MIT License

Copyright Fedor Indutny, 2017.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
USE OR OTHER DEALINGS IN THE SOFTWARE.

## Media tools and packaging

FFmpeg and FFprobe run as external programs for audio extraction and playback. Their license depends on their build configuration. The machine-local Gyan essentials build currently enables GPL components, including libx264 used by the existing optional preview renderer. It is not an audited distribution dependency. A release must inventory all bundled binaries and libraries, preserve notices and corresponding source obligations, and choose compliant media-tool builds. This document covers the new sync dependency; it is not a complete application dependency inventory.
