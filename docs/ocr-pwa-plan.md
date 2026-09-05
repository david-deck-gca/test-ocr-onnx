# Container Mark Reader

## Current status

The Angular 22 PWA shell is implemented. It supports camera capture, device image selection, automatic crop suggestions, manual rectangle crops with previews and saved normalized coordinates, optional cylindrical unwarping with rotation control, editable structured fields, ISO 6346 check-digit validation with targeted OCR recovery, same-row partial-ID detection, per-field confidence percentages, retained initial auto-crop OCR text, local saved records, and accessible technical diagnostics. Auto mode first scans the full photo to suggest a crop; manual mode waits for a user-selected crop. The user interface does not upload images.

The current verification status is `84/84` unit tests passing and a successful production build on 2026-09-05.

Browser OCR is provided by `@gutenye/ocr-browser`, an MIT-licensed browser implementation built on PaddleOCR and ONNX Runtime. The detector and recognizer sessions initialize during Angular application bootstrap. The package performs detector preprocessing, text-region extraction, recognition preprocessing, and CTC decoding on-device. OpenCV.js is shipped as a local static asset but is not yet used by the crop workflow. The UI reports initialization and inference failures with the original technical details.

## Model preparation

The active browser model bundle comes from the `@gutenye/ocr-models` npm package and is copied into the Angular build at:

- `/models/ch_PP-OCRv4_det_infer.onnx`
- `/models/ch_PP-OCRv4_rec_infer.onnx`
- `/models/ppocr_keys_v1.txt`

The package implements the matching image normalization, detector box decoding, crop rectification, CTC decoding, and character dictionary mapping.

## JSON contract

One input image produces one JSON record. It includes source metadata, manual crop coordinates, `container.id`, ISO code, maximum working pressure in bar and PSI, maximum gross weight (`mpgm`, accepting printed `MPGM`, `MGW`, or `MAX.GR.`), TARE, payload, and capacity values in their printed kg/lb/liter/US-gallon/cubic units, OCR confidence values when available, raw text, and warnings. Fields remain empty when their markings are absent. Container IDs are checked against ISO 6346 format and check digit; when normal OCR passes do not produce a valid ID, a targeted same-baseline check-digit OCR pass is attempted automatically. A same-row partial ID can be retained for review with a warning status. OCR fragments from separate rows are not merged into one ID candidate. Slash-paired weights can infer a missing opposite unit, and inferred values are marked in the structured result.

## Local records and recovery

Saving a result writes the JSON payload, a 160px JPEG thumbnail, and the selected image `Blob` to the browser's IndexedDB `container-mark-reader` database. The saved-result list loads only record metadata and thumbnails; the full photo is loaded from a separate IndexedDB store only after the user selects `View photo`. Existing saved photos are migrated to that store, and records without a thumbnail remain readable with a placeholder.

The selected-image and selected-crop previews each retry failed Blob URL loads twice. OCR detection has a 45-second watchdog; after a failure or timeout, the app retries detection once using the already initialized OCR sessions before showing a diagnostic.

## Offline deployment

The Angular service worker pre-caches application files, local ONNX assets, and ONNX Runtime WASM binaries. The Nginx Docker image supplies cross-origin isolation headers. OCR is configured to use one ONNX Runtime WASM thread to reduce memory use on mobile devices. Initial installation requires access to the static server; after assets are cached, browser-side work is offline.

## Image formats

The image picker accepts `image/*`, so it supports formats the user's browser can decode. JPEG (`image/jpeg`), PNG (`image/png`), and WebP (`image/webp`) are recommended and broadly supported for OCR. GIF (`image/gif`) is accepted when supported by the browser, but only its displayed frame is useful for OCR. HEIC/HEIF support depends on the device and browser; convert those photos to JPEG if the browser cannot load them.

## Improvements Backlog

1. Add text-region overlays to the crop editor.
2. Add glare and denoise variants after measuring failure cases on representative container photos.
3. Add a sample-image evaluation set and field-level accuracy benchmark.
4. Add model-version switching and offline cache status management.
