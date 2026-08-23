# Container Mark Reader

## Current status

The Angular 22 PWA shell is implemented. It supports camera capture, device image selection, manual rectangle crops with previews and saved normalized coordinates, editable structured fields, ISO 6346 check-digit validation, local saved records, and accessible technical diagnostics. OCR normally scans the full photo unless a manual crop is selected. The user interface does not upload images.

`npm run build` and `npm test -- --watch=false` passed on 2026-08-23.

Browser OCR is provided by `@gutenye/ocr-browser`, an MIT-licensed browser implementation built on PaddleOCR and ONNX Runtime. The detector and recognizer sessions initialize during Angular application bootstrap. The package performs detector preprocessing, text-region extraction, recognition preprocessing, and CTC decoding on-device. OpenCV.js is shipped as a local static asset but is not yet used by the crop workflow. The UI reports initialization and inference failures with the original technical details.

## Model preparation

The active browser model bundle comes from the `@gutenye/ocr-models` npm package and is copied into the Angular build at:

- `/models/ch_PP-OCRv4_det_infer.onnx`
- `/models/ch_PP-OCRv4_rec_infer.onnx`
- `/models/ppocr_keys_v1.txt`

The package implements the matching image normalization, detector box decoding, crop rectification, CTC decoding, and character dictionary mapping.

## JSON contract

One input image produces one JSON record. It includes source metadata, manual crop coordinates, `container.id`, ISO code, maximum gross weight (`mpgm`, accepting printed `MPGM`, `MGW`, or `MAX.GR.`), TARE, payload, and capacity values in their printed kg/lb/liter/cubic units, raw text, and warnings. Fields remain empty when their markings are absent. Container IDs are checked against ISO 6346 format and check digit; questionable values remain visible for correction.

## Local records and recovery

Saving a result writes both the JSON payload and the selected image `Blob` to the browser's IndexedDB `container-mark-reader` database. Saved records are loaded when the app opens and shown with a small local photo preview, JSON viewer, and delete action. Records saved before image persistence remain readable and are shown without a photo.

The selected-image and selected-crop previews each retry failed Blob URL loads twice. OCR detection has a 45-second watchdog; after a failure or timeout, the app retries detection once using the already initialized OCR sessions before showing a diagnostic.

## Offline deployment

The Angular service worker pre-caches application files, local ONNX assets, and ONNX Runtime WASM binaries. The Nginx Docker image supplies cross-origin isolation headers. OCR is configured to use one ONNX Runtime WASM thread to reduce memory use on mobile devices. Initial installation requires access to the static server; after assets are cached, browser-side work is offline.

## Image formats

The image picker accepts `image/*`, so it supports formats the user's browser can decode. JPEG (`image/jpeg`), PNG (`image/png`), and WebP (`image/webp`) are recommended and broadly supported for OCR. GIF (`image/gif`) is accepted when supported by the browser, but only its displayed frame is useful for OCR. HEIC/HEIF support depends on the device and browser; convert those photos to JPEG if the browser cannot load them.

## Improvements backlog

1. Add a four-corner crop editor and text-region overlays.
2. Complete and test PaddleOCR ONNX preprocessing and postprocessing with real container images.
3. Add glare and denoise variants after measuring failure cases on representative container photos.
4. Add curved-text unwarping after measuring failure cases on representative container photos.
5. Add a sample-image evaluation set and field-level accuracy benchmark.
6. Add model-version switching and offline cache status management.
