# Image Processing and OCR Flow

This document describes what the application does after the user selects or captures a photo. The original image is kept unchanged for local storage; OCR uses temporary decoded, cropped, and/or resized copies.

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

## Crop Mode Selection

The application selects **Manual** by default on Android and iOS. It selects **Auto** by default on other platforms. The user can change the mode before selecting an image.

Changing the mode after an image has already been selected only changes the selected mode. It does not automatically restart processing for the existing image.

## Manual Crop Mode

After a photo is selected in Manual mode:

- Automatic OCR does not start.
- The user draws a rectangle around the container ID and markings.
- The rectangle can be resized using its four corner handles.
- The crop coordinates are stored as normalized values from `0` to `1` relative to the original image.
- A crop smaller than 2% of the image width or height is rejected.
- The user starts OCR with **Scan selected crop region**.

### Manual OCR Pass 1

The selected region is processed with a requested scale of `1x` and a maximum of 4,000,000 output pixels.

The effective output scale is the smallest of:

- The requested scale (`1x`).
- The scale required to remain within the 4 MP limit.
- The scale allowed by the optional runtime memory budget.

Consequences:

- A crop at or below 4 MP is normally processed at its original crop dimensions.
- A crop larger than 4 MP is downscaled to approximately 4 MP or less.
- A small crop is not enlarged during this pass.

### Manual OCR Pass 2

The application then performs an **Enlarged** pass with a requested scale of `2x`, also capped at 4,000,000 output pixels.

Consequences:

- A small crop can be enlarged to improve character recognition.
- A medium crop is enlarged only until it reaches the 4 MP limit.
- A crop already near or above 4 MP may remain approximately the same size or be reduced.
- The runtime memory budget can impose a lower limit than the configured 4 MP cap.

Both passes are processed sequentially. The temporary OCR image from one pass is released before the next pass is created. Results from both passes are combined and duplicate detected text is removed.

### Optional Cylindrical Unwarp

For cylindrical containers, the user can enable **Unwarp** after selecting a crop. The optional rotation adjustment ranges from `-10` to `+10` degrees. The application then performs three sequential passes:

1. **Original size**: the selected crop without unwarping.
2. **Unwarped**: the selected crop transformed with the configured rotation and cylindrical curvature.
3. **2x unwarped**: the same transformation at an enlarged scale, subject to the 4 MP and memory limits.

The first pass estimates text-line geometry and supplies a bounded rotation correction when the estimate is reliable. The unwarped pass is retained as a temporary preview for diagnosis; it is not saved instead of the original photo.

## Auto Crop Mode

After a photo is selected in Auto mode:

1. The application waits for the preview image to finish loading.
2. It scans the full photo to locate the container ID and nearby markings.
3. The full-photo OCR pass is limited to 4,000,000 output pixels.
4. If that pass fails, it retries with a 1,000,000-pixel limit.
5. The detected OCR boxes are mapped back to the original image dimensions.
6. If a suitable container ID and markings are found, the application proposes a crop around them.
7. The user can review and resize the proposed crop.

The suggested crop is not processed automatically. The user must press **Scan selected crop region**. At that point, the selected crop uses the two manual OCR passes described above.

If automatic detection cannot propose a crop, the user can draw one manually. If the user does not draw a crop, scanning processes the full image as the selected region.

## Pixel-Based Resizing

Resizing is based on decoded pixel dimensions, not the compressed file size in megabytes.

Examples:

- A 3 MB JPEG can still be resized if its decoded dimensions exceed the pixel limit.
- A 10 MB JPEG may not be resized if its decoded dimensions are within the limit.
- A photo of 4000 x 2000 pixels contains 8 MP and is reduced for a 4 MP pass.
- A crop of 1000 x 800 pixels contains 0.8 MP and can be enlarged during the `2x` retry pass, subject to the 4 MP and memory limits.

The application does not use a device-wide free-memory API. If the browser exposes the non-standard `performance.memory` information, the application estimates a conservative temporary pixel budget from the available JavaScript heap. Otherwise, it uses the configured pixel limit.

## Temporary Image Handling

For each OCR pass, the application:

1. Decodes the original image using `ImageBitmap` when available.
2. Falls back to an HTML image element if `ImageBitmap` decoding fails.
3. Draws the required crop and scale onto a temporary canvas.
4. Encodes the canvas as a temporary PNG Blob.
5. Runs local OCR against the temporary object URL.
6. Revokes the object URL after the pass.
7. Releases the decoded bitmap and clears the canvas backing store.

The original image Blob remains available throughout the process and is not modified.

## Preview and OCR Recovery

If the image preview fails to load:

- The application creates a fresh object URL and retries up to two times.
- After the retry limit is reached, it clears the preview and displays a diagnostic.

If OCR fails or times out:

- A single local OCR retry is attempted using the initialized OCR session.
- A normal-size Auto pass can additionally fall back from 4 MP to 1 MP.
- Memory-related failures display a recommendation to use a tighter crop or smaller photo.
- Decode failures report the image type, approximate file size, and decoder errors.

## Check-Digit Recovery

After the normal crop passes complete, the application accepts a container ID only when it has a valid ISO 6346 check digit. If no normal pass produces a valid ID, it automatically creates a targeted crop around the expected tenth character and runs a separate local OCR pass. The target is restricted to OCR fragments on the same baseline as the first ten ID characters, and only checksum-valid candidates are accepted.

The targeted crop is shown as a diagnostic preview and is included in the raw OCR scan list. It does not replace the normal OCR results.

## Structured Markings

The extracted result includes:

- Maximum gross weight (`MPGM`, `MGW`, or `MAX.GR.`) in kilograms and pounds.
- TARE and payload weights in kilograms and pounds.
- Capacity in printed liters, US gallons, cubic meters, and cubic feet.

For slash-paired weights, an unreadable second unit may be inferred from the readable first unit. For example, `4300KG/9480s` produces `4300 KG` and inferred `9480 LB`. Explicit units remain authoritative, and inferred fields are marked as inferred in the result.

## Results and Saving

After OCR succeeds:

- Text from all completed passes is deduplicated.
- Structured container fields are extracted.
- The user can edit the extracted fields.
- The original image Blob is saved to IndexedDB when the user selects **Save on this device**.
- A separate 160-pixel JPEG thumbnail is generated for the saved-results list.
- The JSON record stores the source filename, processing time, crop coordinates, extracted fields, raw OCR text, and warnings.

The resized OCR copies and temporary canvases are not used as the saved full photo.

## Relevant Implementation

The behavior described here is implemented primarily in:

- `src/app/app.ts`
- `src/app/ocr.service.ts`
