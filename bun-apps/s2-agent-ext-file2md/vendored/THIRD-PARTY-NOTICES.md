# Third-party notices

This package runs document, PDF, OCR, and image conversion locally, without a
browser or a network service. Every binary/model asset below ships through npm
(`bun install` from `bun-apps/`) — nothing is fetched at install or runtime.

## tesseract-wasm 0.11.0

- Project: https://github.com/robertknight/tesseract-wasm
- License: BSD-2-Clause
- Purpose: local, in-process OCR (low-level `OCREngine`) for scanned PDF pages
  and images; the wasm core and JS bundle come from the npm package's `dist/`.
- Bundled artifacts: `tesseract-core.wasm`, `tesseract-core-fallback.wasm`,
  `tesseract-worker.js` (npm `tesseract-wasm@0.11.0` dist)

## Tesseract language data (`@tesseract.js-data/eng` + `@tesseract.js-data/chi_sim` 1.0.0)

- Packages: https://github.com/naptha/tessdata (npm wrapper, MIT)
- Source data: tessdata 4.0.0 best-int (`tesseract-ocr/tessdata`, Apache-2.0 —
  see the project LICENSE; individual traineddata files carry their own notices)
- Purpose: eng + chi_sim OCR models, gzipped `.traineddata` inside the npm
  packages, gunzipped in-process (tessdata_fast external-store references from
  v1/v2 are gone — this npm set is the current source).
- Bundled artifacts: `4.0.0_best_int/eng.traineddata.gz`,
  `4.0.0_best_int/chi_sim.traineddata.gz` (npm `@tesseract.js-data/{eng,chi_sim}@1.0.0`)

## @hyzyla/pdfium 2.1.13

- Project: https://github.com/hyzyla/pdfium
- License: MIT
- Purpose: local PDF page rasterization to raw BGRA (scanned-page OCR path);
  the wasm binary ships inside the npm package (`dist/pdfium.wasm`).

## PDF.js 6.2.108

- Project: https://github.com/mozilla/pdf.js
- License: Apache License 2.0
- Purpose: local PDF text and embedded-image extraction (npm `pdfjs-dist`)

## pngjs 7.0.0

- Project: https://github.com/pngjs/pngjs
- License: MIT
- Purpose: PNG decode/encode

## jpeg-js 0.4.4

Copyright (c) 2014, Eugene Ware

All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
3. Neither the name of Eugene Ware nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY EUGENE WARE "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL EUGENE WARE BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## dsh-cowork-core 0.1.0 (vendored source snapshot)

- Project: the user's own `@dsh-cowork/core` (MIT); vendored under `vendored/`
  with LICENSE, VERSION, and README beside the source.
- Purpose: document windows/extraction (docx/xlsx/pptx/ipynb/pdf text).
