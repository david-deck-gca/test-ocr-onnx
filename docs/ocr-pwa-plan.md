# Container Mark Reader

## Current status

The Angular 22 PWA shell is implemented. It supports camera capture, device image selection, full-photo and guided-crop modes, editable structured fields, ISO 6346 check-digit validation, local JSON export, and accessible technical diagnostics. The user interface does not upload images.

`npm run build` and `npm test -- --watch=false` passed on 2026-07-28. The two public PaddleOCR source archives were also downloaded to `models/source/`.

Browser OCR is provided by `@gutenye/ocr-browser`, an MIT-licensed browser implementation built on PaddleOCR and ONNX Runtime. It performs detector preprocessing, text-region extraction, recognition preprocessing, and CTC decoding on-device. OpenCV.js is served as a local static asset for perspective crops. The UI reports initialization and inference failures with the original technical details.

## Model preparation

`npm run models:download` retains the official PaddleOCR source inference archives for provenance:

- PP-OCRv5 mobile text detector
- English PP-OCRv5 mobile recognizer

The active browser model bundle comes from the `@gutenye/ocr-models` npm package and is copied into the Angular build at:

- `/models/ch_PP-OCRv4_det_infer.onnx`
- `/models/ch_PP-OCRv4_rec_infer.onnx`
- `/models/ppocr_keys_v1.txt`

The package implements the matching image normalization, detector box decoding, crop rectification, CTC decoding, and character dictionary mapping. The older downloaded PP-OCRv5 source archives are not included in the deployed model bundle because their current Paddle 3 export format could not be converted with the available Windows Paddle2ONNX binary.

## JSON contract

One input image exports one JSON record. It includes source metadata, processing mode, `container.id`, ISO code, maximum gross weight (`mpgm`, accepting printed `MPGM`, `MGW`, or `MAX.GR.`) and TARE in kg/lb, optional capacity in liters or separate cubic-meter and cubic-foot fields, raw text, and warnings. When payload is printed, the review UI also calculates `MPGM - TARE`; the user selects either the detected or calculated payload for export, recorded as `container.payload.source`. Fields remain empty when their markings are absent. Container IDs are checked against ISO 6346 format and check digit; questionable values remain visible for correction.

## Offline deployment

The Angular service worker pre-caches application files, local ONNX assets, and ONNX Runtime WASM binaries. The Nginx Docker image supplies cross-origin isolation headers for multi-threaded WASM. Initial installation requires access to the static server; after assets are cached, browser-side work is offline.

## Image formats

The image picker accepts `image/*`, so it supports formats the user's browser can decode. JPEG (`image/jpeg`), PNG (`image/png`), and WebP (`image/webp`) are recommended and broadly supported for OCR. GIF (`image/gif`) is accepted when supported by the browser, but only its displayed frame is useful for OCR. HEIC/HEIF support depends on the device and browser; convert those photos to JPEG if the browser cannot load them.

## Improvements backlog

1. High priority: add a manual rectangle crop editor with a preview, OCR of the selected region, and saved crop coordinates. This is the reliable fallback for difficult or oblique marking panels.
2. Add a four-corner crop editor and text-region overlays.
3. Complete and test PaddleOCR ONNX preprocessing and postprocessing with real container images.
4. Add tiled/multi-scale detection and controlled contrast, glare, and denoise variants.
5. Add curved-text unwarping after measuring failure cases on representative container photos.
6. Add a sample-image evaluation set and field-level accuracy benchmark.
7. Add model-version switching and offline cache status management.
