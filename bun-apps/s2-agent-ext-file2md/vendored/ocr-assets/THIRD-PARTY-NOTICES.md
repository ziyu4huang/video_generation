# Third-party notices

This Skill bundles these assets so document, PDF, OCR, and image conversion can run locally without a browser or network service.

## resvg-wasm 2.6.2

- Project: https://github.com/yisibl/resvg-js
- License: Mozilla Public License 2.0
- License text: https://www.mozilla.org/MPL/2.0/
- Bundled artifact: `assets/render/resvg.wasm`

The corresponding source is available from the project repository and its `v2.6.2` release/tag history under the MPL-2.0 terms.

## jpeg-js 0.4.4

Copyright (c) 2014, Eugene Ware

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of Eugene Ware nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY EUGENE WARE "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL EUGENE WARE BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Noto Sans CJK SC/JP Regular

- Project: https://github.com/notofonts/noto-cjk
- License: SIL Open Font License 1.1
- Bundled artifacts: `assets/fonts/NotoSansCJKsc-Regular.otf` and `assets/fonts/NotoSansCJKjp-Regular.otf`
- Full license text: `assets/fonts/OFL.txt`

## pdfmake 0.3.11 and PDFKit 0.19.1

- Projects: https://github.com/bpampuch/pdfmake and https://github.com/foliojs/pdfkit
- License: MIT
- Purpose: searchable, selectable PDF output

## PDF.js 6.2.108

- Project: https://github.com/mozilla/pdf.js
- License: Apache License 2.0
- Purpose: local PDF text and embedded-image extraction

## Tesseract-wasm 0.11.0

- Project: https://github.com/robertknight/tesseract-wasm
- License: BSD-2-Clause
- Purpose: local, in-process OCR (low-level `OCREngine`) for scanned PDF pages and images; wasm core + JS bundle come from the npm package's `dist/`.
- Bundled artifacts: `tesseract-core.wasm`, `tesseract-core-fallback.wasm`, `tesseract-worker.js` (npm `tesseract-wasm@0.11.0` dist)

## Tesseract language data (tessdata_fast)

- Project: https://github.com/tesseract-ocr/tessdata_fast
- License: Apache License 2.0 (see the project README/LICENSE; individual traineddata files carry their own notices)
- Bundled languages: English (`eng`), Simplified Chinese (`chi_sim`) — raw `.traineddata`, vendored via symlinks into the external binary store (`../video_generation__models/file2md-ocr-assets/lang/`)
