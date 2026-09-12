# Container Mark Reader

## Project Status

The Angular 22 PWA shell is implemented. It supports camera capture, device image selection, automatic crop suggestions, manual rectangle crops with previews and saved normalized coordinates, editable structured fields, ISO 6346 check-digit validation with targeted OCR recovery, same-row partial-ID detection, per-field confidence percentages, retained initial auto-crop OCR text, local saved records, remote saved-record synchronization, and accessible technical diagnostics.

Auto mode first scans the full photo to suggest a crop; manual mode waits for a user-selected crop. Images and OCR records are stored locally in the browser database and uploaded in the background when the remote service is available.

Remote synchronization uses a local pending queue, oldest-first uploads, online/offline handling, exponential retry, and per-record remote status. Local records remain available when the service is unavailable.

## Development Setup

Open the application at the configured deployment URL or run the Angular development server locally with `npm start`.

The application is intended to run in a browser with camera access and local storage support. Camera access requires HTTPS or `localhost`.

## OCR Models

Browser OCR is provided by `@gutenye/ocr-browser`, an MIT-licensed browser implementation built on PaddleOCR and ONNX Runtime. Detector and recognizer sessions initialize during Angular application bootstrap. The package performs detector preprocessing, text-region extraction, recognition preprocessing, and CTC decoding on-device.

OpenCV.js is shipped as a local static asset but is not currently used by the crop workflow. The UI reports initialization and inference failures with the original technical details.

The active browser model bundle comes from the `@gutenye/ocr-models` npm package and is copied into the Angular build at:

- `/models/ch_PP-OCRv4_det_infer.onnx`
- `/models/ch_PP-OCRv4_rec_infer.onnx`
- `/models/ppocr_keys_v1.txt`

The package implements the matching image normalization, detector box decoding, crop rectification, CTC decoding, and character dictionary mapping.

## Photo Sources

The user can provide an image in two ways:

- **Existing**: select an image from the device.
- **New**: capture an image with the device camera. The rear camera is preferred, with an ideal capture size of 1920 x 1080 pixels.

For an existing image, the application:

1. Verifies that the selected file has an `image/*` MIME type.
2. Keeps the original `Blob` in memory.
3. Creates a preview object URL.
4. Clears previous OCR fields and detected text.
5. Resets the crop to the full image.
6. Displays the image in the crop editor.

The original file is not replaced by a resized OCR image.

## Camera Alignment

The camera preview provides advisory roll guidance. It combines:

- Visual analysis of strong horizontal edges in the preview.
- Device orientation as a fallback when visual evidence is insufficient.
- Screen-orientation normalization for portrait, landscape, and upside-down device orientations.

The capture button remains enabled when the camera is tilted. A warning is shown when the estimated roll exceeds approximately 3 degrees. No post-capture rotation or perspective correction is currently applied.

## Crop Modes

The application selects **Auto** by default. The user can change the mode before selecting an image.

Changing the mode after an image has already been selected only changes the selected mode. It does not automatically restart processing for the existing image.

### Manual Crop Mode

After a photo is selected in Manual mode:

- Automatic OCR does not start.
- The user draws a rectangle around the container ID and markings.
- The rectangle can be resized using its four corner handles.
- Crop coordinates are stored as normalized values from `0` to `1` relative to the original image.
- A crop smaller than 2% of the image width or height is rejected.
- The user starts OCR with **Scan selected crop region**.

### Manual OCR Pass 1

The selected region is processed with a requested scale of `1x` and a maximum of 4,000,000 output pixels.

The effective output scale is the smallest of:

- The requested scale (`1x`).
- The scale required to remain within the 4 MP limit.
- The scale allowed by the optional runtime memory budget.

A crop at or below 4 MP is normally processed at its original crop dimensions. A crop larger than 4 MP is downscaled to approximately 4 MP or less. A small crop is not enlarged during this pass.

### Manual OCR Pass 2

The application then performs an **Enlarged** pass with a requested scale of `2x`, also capped at 4,000,000 output pixels.

A small crop can be enlarged to improve character recognition. A medium crop is enlarged only until it reaches the 4 MP limit. A crop already near or above 4 MP may remain approximately the same size or be reduced. The runtime memory budget can impose a lower limit than the configured 4 MP cap.

Both passes are processed sequentially. The temporary OCR image from one pass is released before the next pass is created. Results from both passes are combined and duplicate detected text is removed.

For a manually selected engraved date marking known to use the `MM YY` format, the application also scans four fixed character slots independently at high scale. Common OCR letter-to-digit confusions are normalized, but a combined date is added only when the month is between `01` and `12` and all four digits are present. Each slot's raw OCR results remain visible even when no valid date can be synthesized.

### Auto Crop Mode

After a photo is selected in Auto mode:

1. The application waits for the preview image to finish loading.
2. It scans the full photo to locate the container ID and nearby markings.
3. The full-photo OCR pass is limited to 4,000,000 output pixels.
4. If that pass fails, it retries with a 1,000,000-pixel limit.
5. Detected OCR boxes are mapped back to the original image dimensions.
6. A complete ISO 6346 container ID, or a same-row partial ID anchor, is accepted as a successful initial detection.
7. If a suitable ID and markings are found, the application proposes a crop around them.
8. The user can review and resize the proposed crop.

The suggested crop is not processed automatically. The user must press **Scan selected crop region**. At that point, the selected crop uses the two manual OCR passes described above.

The initial OCR result remains visible in the raw detected text section, including when no crop is proposed. If automatic detection cannot propose a crop, the user can draw one manually. If the user does not draw a crop, scanning processes the full image as the selected region.

## Image Processing

Resizing is based on decoded pixel dimensions, not the compressed file size in megabytes:

- A 3 MB JPEG can still be resized if its decoded dimensions exceed the pixel limit.
- A 10 MB JPEG may not be resized if its decoded dimensions are within the limit.
- A photo of 4000 x 2000 pixels contains 8 MP and is reduced for a 4 MP pass.
- A crop of 1000 x 800 pixels contains 0.8 MP and can be enlarged during the `2x` retry pass, subject to the 4 MP and memory limits.

The application does not use a device-wide free-memory API. If the browser exposes the non-standard `performance.memory` information, the application estimates a conservative temporary pixel budget from the available JavaScript heap. Otherwise, it uses the configured pixel limit.

For each OCR pass, the application:

1. Decodes the original image using `ImageBitmap` when available.
2. Falls back to an HTML image element if `ImageBitmap` decoding fails.
3. Draws the required crop and scale onto a temporary canvas.
4. Encodes the canvas as a temporary PNG `Blob`.
5. Runs local OCR against the temporary object URL.
6. Revokes the object URL after the pass.
7. Releases the decoded bitmap and clears the canvas backing store.

The original image `Blob` remains available throughout the process and is not modified.

## Image Formats

The image picker accepts `image/*`, so it supports formats the user's browser can decode. JPEG (`image/jpeg`), PNG (`image/png`), and WebP (`image/webp`) are recommended and broadly supported for OCR. GIF (`image/gif`) is accepted when supported by the browser, but only its displayed frame is useful for OCR. HEIC/HEIF support depends on the device and browser; convert those photos to JPEG if the browser cannot load them.

## OCR Recovery

If the image preview fails to load, the application creates a fresh object URL and retries up to two times. After the retry limit is reached, it clears the preview and displays a diagnostic.

If OCR fails or times out:

- A single local OCR retry is attempted using the initialized OCR session.
- A normal-size Auto pass can additionally fall back from 4 MP to 1 MP.
- Memory-related failures display a recommendation to use a tighter crop or smaller photo.
- Decode failures report the image type, approximate file size, and decoder errors.

## Check-Digit Recovery

After the normal crop passes complete, the application accepts a container ID only when it has a valid ISO 6346 check digit. If no normal pass produces a valid ID, it automatically creates a targeted crop around the expected tenth character and runs a separate local OCR pass.

The target is restricted to OCR fragments on the same baseline as the first ten ID characters, and only checksum-valid candidates are accepted. A same-row partial ID can still be shown when the check digit is unavailable; it is marked with a warning icon rather than a valid check mark. OCR fragments from different rows are not concatenated into a candidate ID.

The targeted crop is shown as a diagnostic preview and is included in the raw OCR scan list. It does not replace the normal OCR results.

## Structured Markings

The extracted result includes:

- Maximum working pressure in bar and PSI.
- Maximum gross weight (`MPGM`, `MGW`, or `MAX.GR.`) in kilograms and pounds.
- TARE and payload weights in kilograms and pounds.
- Capacity in printed liters, US gallons, cubic meters, and cubic feet.
- For UN tanks, the first two rows matching `number KG / number letters` are extracted as maximum gross weight and TARE. The first number is stored as kilograms and the second as pounds.
- For UN tanks, a row matching `number L / number US GAL` is extracted as capacity. The two OCR rows immediately following that row are extracted as the Kemler code and UN number.

For slash-paired weights, an unreadable second unit may be inferred from the readable first unit. For example, `4300KG/9480s` produces `4300 KG` and inferred `9480 LB`. Explicit units remain authoritative, and inferred fields are marked as inferred in the result.

The UN-tank pattern rules take precedence over positional assumptions and do not infer missing weight units. Rows that do not contain the required `KG` suffix and trailing letter suffix are ignored for UN-tank weight extraction.

## JSON Contract

One input image produces one JSON record. It includes source metadata, manual crop coordinates, `container.id`, ISO code, maximum working pressure in bar and PSI, maximum gross weight (`mpgm`, accepting printed `MPGM`, `MGW`, or `MAX.GR.`), TARE, payload, and capacity values in their printed kg/lb/liter/US-gallon/cubic units, OCR confidence values when available, raw text, and warnings.

Fields remain empty when their markings are absent. Container IDs are checked against ISO 6346 format and check digit; when normal OCR passes do not produce a valid ID, a targeted same-baseline check-digit OCR pass is attempted automatically. A same-row partial ID can be retained for review with a warning status. OCR fragments from separate rows are not merged into one ID candidate.

For UN tanks, the first two OCR rows matching `number KG / number letters` are interpreted as maximum gross weight and TARE, respectively; the first number is kilograms and the second is pounds. The first row matching `number L / number US GAL` supplies capacity, and the next two OCR rows supply the Kemler code and UN number. Generic slash-paired weight inference remains available for non-UN-tank markings.

## Local Records and Synchronization

Engraved `MM YY` markings use a fixed four-slot OCR fallback during Data plate scans. The slots and any valid synthesized date are retained in raw OCR results; no new structured field is created yet.

Saving a result writes the JSON payload, a 160px JPEG thumbnail, and the selected image `Blob` to the browser's IndexedDB `container-mark-reader` database. The saved-result list loads only record metadata and thumbnails; the full photo is loaded from a separate IndexedDB store only after the user selects **View photo**.

Existing saved photos are migrated to that store, and records without a thumbnail remain readable with a placeholder. Pending records are posted to the configured saved-results API with JSON, the original image, and its thumbnail; successful uploads are marked remotely saved.

The selected-image and selected-crop previews each retry failed Blob URL loads twice. OCR detection has a 45-second watchdog; after a failure or timeout, the app retries detection once using the already initialized OCR sessions before showing a diagnostic.

After OCR succeeds:

- Text from all completed passes is deduplicated.
- Structured container fields are extracted.
- A whole-number confidence percentage is shown for each extracted field when OCR provides one.
- The user can edit the extracted fields.
- The original image Blob is saved when the user selects **Save on this device**.
- A separate 160-pixel JPEG thumbnail is generated for the saved-results list.
- The JSON record stores the source filename, processing time, crop coordinates, extracted fields, raw OCR text, and warnings.
- Saved records are written locally first, then synchronized oldest-first to the remote saved-results API when online.
- Each record shows whether it is remotely saved; failed uploads remain local and retry with exponential backoff, while offline uploads resume on the next `online` event.

The resized OCR copies and temporary canvases are not used as the saved full photo.

## Offline Deployment

The Angular service worker pre-caches application files, local ONNX assets, and ONNX Runtime WASM binaries. The Nginx Docker image supplies cross-origin isolation headers. OCR is configured to use one ONNX Runtime WASM thread to reduce memory use on mobile devices. Initial installation requires access to the static server; after assets are cached, browser-side work is offline.

## Testing

Run unit tests with:

```text
npm test
```

Run the complete Playwright E2E suite with:

```text
npm run test:e2e
```

Use a maximum command timeout of `240000` ms (4 minutes) so the Chromium and WebKit suites can complete.

## Relevant Implementation

The documented behavior is implemented primarily in:

- `src/app/app.ts`
- `src/app/ocr.service.ts`
- `src/app/app.html`
- `src/app/app.css`
- `src/app/app.spec.ts`
- `e2e/container-markings.spec.ts`

## Improvements Backlog

1. Add text-region overlays to the crop editor.
2. Add glare and denoise variants after measuring failure cases on representative container photos.
3. Add a sample-image evaluation set and field-level accuracy benchmark.
4. Add model-version switching and offline cache status management.
5. Improve partial-ID check-digit recovery with an OCR ensemble: scan the full ID row at 2x, scan the rightmost digit area at 3x, accept only checksum-valid OCR candidates, and distinguish directly detected digits from checksum-inferred fallback values.
6. Investigate the iPhone automatic-crop issue reproduced with `general-purpose_4ft_frontal.webp`: the selected region can be too narrow on the right, clipping the ISO 6346 check digit so only part of it is scanned and the digit must be inferred. Preserve enough right-side margin for the complete digit and validate the improvement on iPhone.
