import { Component, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { OcrService } from './ocr.service';

type CaptureMode = 'auto-crop' | 'manual-crop';
type FieldKey = 'maxWorkingPressureBar' | 'maxWorkingPressurePsi' | 'containerId' | 'isoCode' | 'mpgmKg' | 'mpgmLb' | 'tareKg' | 'tareLb' | 'payloadKg' | 'payloadLb' | 'capacityLiters' | 'capacityUsGallons' | 'capacityCubicMeters' | 'capacityCubicFeet';
type OcrLine = { text: string; mean: number; box?: number[][] };
type UnwarpGeometry = { rotation: number; curvature: number; reliable: boolean };
type CropRect = { x: number; y: number; width: number; height: number };
type BoxBounds = { left: number; top: number; right: number; bottom: number };
type CropResizeHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type DecodedImage = { source: CanvasImageSource; width: number; height: number; release: () => void };
type RawScan = { label: string; lines: Array<{ text: string; confidence: number }>; durationMs: number };
type StoredRecord = { id: string; savedAt: string; payload: unknown; thumbnail?: Blob; hasImage?: boolean; image?: Blob };
type StoredImage = { id: string; image: Blob };
type SavedRecord = StoredRecord & { thumbnailUrl: string | null };
const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };
const MAX_FULL_PHOTO_PIXELS = 4_000_000;
const MAX_AUTO_CROP_FALLBACK_PIXELS = 1_000_000;
const MAX_MANUAL_CROP_PIXELS = 4_000_000;
const MAX_MANUAL_RETRY_CROP_PIXELS = 4_000_000;
const MAX_CHECK_DIGIT_CROP_PIXELS = 1_000_000;
const MAX_PREVIEW_RETRIES = 2;
const OCR_PASS_TIMEOUT_MS = 45_000;
const CROP_MEMORY_HEADROOM = 0.25;
const CROP_BYTES_PER_PIXEL = 16;
// Use a strong enough curvature correction to be visible on container sides.
const DEFAULT_AUTO_CURVATURE = 0.25;
const CYLINDER_UNWARP_MAX_SEGMENTS = 512;
const THUMBNAIL_MAX_DIMENSION = 160;
const THUMBNAIL_JPEG_QUALITY = 0.8;

function defaultCaptureMode(): CaptureMode {
  return 'auto-crop';
}

interface ContainerField {
  value: string;
  unit?: string;
  confidence?: number;
  inferred?: boolean;
}

interface Diagnostic {
  stage: string;
  message: string;
  technical?: string;
}

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  protected readonly previewImage = viewChild<ElementRef<HTMLImageElement>>('previewImage');
  protected readonly videoPreview = viewChild<ElementRef<HTMLVideoElement>>('videoPreview');
  protected readonly sourceName = signal('');
  protected readonly previewUrl = signal<string | null>(null);
  protected readonly unwarpedCropUrl = signal<string | null>(null);
  protected readonly checkDigitPreviewUrl = signal<string | null>(null);
  protected readonly imageBlob = signal<Blob | null>(null);
  protected readonly cropRect = signal<CropRect | null>(null);
  protected readonly cropDraft = signal<CropRect>(DEFAULT_CROP);
  protected readonly applyingCrop = signal(false);
  protected readonly cropResizeHandles: CropResizeHandle[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  protected readonly captureMode = signal<CaptureMode>(defaultCaptureMode());
  protected readonly unwarpSelectedRegion = signal(false);
  protected readonly unwarpRotation = signal(0);
  protected readonly cameraOpen = signal(false);
  protected readonly processing = signal(false);
  protected readonly analysisSuccessful = signal(false);
  protected readonly status = signal('Choose a container image to begin.');
  protected readonly diagnostics = signal<Diagnostic[]>([]);
  protected readonly rawText = signal<string[]>([]);
  protected readonly rawScans = signal<RawScan[]>([]);
  private readonly selectedOcrLines = signal<OcrLine[]>([]);
  protected readonly savedRecords = signal<SavedRecord[]>([]);
  protected readonly savedJson = signal<string | null>(null);
  protected readonly savedPhoto = signal<{ id: string; name: string; url: string } | null>(null);
  protected readonly fields = signal<Record<FieldKey, ContainerField>>({
    maxWorkingPressureBar: { value: '', unit: 'BAR' },
    maxWorkingPressurePsi: { value: '', unit: 'PSI' },
    containerId: { value: '' },
    isoCode: { value: '' },
    mpgmKg: { value: '', unit: 'KG' },
    mpgmLb: { value: '', unit: 'LB' },
    tareKg: { value: '', unit: 'KG' },
    tareLb: { value: '', unit: 'LB' },
    payloadKg: { value: '', unit: 'KG' },
    payloadLb: { value: '', unit: 'LB' },
    capacityLiters: { value: '', unit: 'L' },
    capacityUsGallons: { value: '', unit: 'US GAL' },
    capacityCubicMeters: { value: '', unit: 'CU.M.' },
    capacityCubicFeet: { value: '', unit: 'CU.FT.' },
  });
  protected readonly containerIdValid = computed(() => this.validateContainerId(this.fields().containerId.value));
  protected readonly containerIdPartial = computed(() => /^[A-Z]{3}[UJZ]\d{6}$/.test(this.fields().containerId.value));
  protected readonly formattedContainerId = computed(() => this.formatContainerId(this.fields().containerId.value));
  protected readonly hasImage = computed(() => this.previewUrl() !== null);
  protected readonly detectedMarkings = computed(() => {
    const text = this.rawText().join('\n').toUpperCase();
    return {
      mpgm: /\bMPGM\b/.test(text),
      mgw: /\bMGW\b/.test(text),
      maxGr: /\bMAX\.?\s*GR\.?/.test(text),
      payload: /\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)/.test(text),
      net: /\bNET(?:\s*WEIGHT)?\b/.test(text),
    };
  });
  protected readonly detectedWeightLabels = computed(() => {
    const markings = this.detectedMarkings();
    return {
      gross: markings.mpgm ? 'MPGM' : markings.mgw ? 'MGW' : markings.maxGr ? 'MAX.GR.' : '',
      payload: markings.payload ? 'PAYLOAD' : markings.net ? 'NET' : '',
    };
  });

  private stream: MediaStream | null = null;
  private readonly injector = inject(Injector);
  private readonly ocrService = inject(OcrService);
  private cropStart: { x: number; y: number } | null = null;
  private cropResize: { handle: CropResizeHandle; crop: CropRect } | null = null;
  private imageSelection = 0;
  private previewRetries = 0;
  private previewLoad: { selection: number; resolve: (image: HTMLImageElement) => void; reject: (reason: Error) => void } | null = null;

  protected openFilePicker(): void {
    this.clearFields();
    this.fileInput()?.nativeElement.click();
  }

  protected selectFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/')) {
      this.addDiagnostic('File selection', 'Please select an image file.', `Received ${file.type || 'an unknown file type'}.`);
      input.value = '';
      return;
    }
    this.useImage(file, file.name);
    input.value = '';
  }

  protected startCrop(event: PointerEvent): void {
    if (this.processing() || this.applyingCrop()) return;
    const point = this.cropPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.cropStart = point;
    this.cropResize = null;
    this.cropDraft.set({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  protected startCropResize(event: PointerEvent, handle: CropResizeHandle): void {
    if (this.processing() || this.applyingCrop()) return;
    const point = this.cropPoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = (event.currentTarget as HTMLElement).closest('.crop-canvas');
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
    this.cropStart = null;
    this.cropResize = { handle, crop: this.cropDraft() };
  }

  protected updateCrop(event: PointerEvent): void {
    if (this.processing() || this.applyingCrop()) return;
    const point = this.cropPoint(event);
    if (!point) return;
    if (this.cropResize) {
      this.resizeCrop(this.cropResize.handle, this.cropResize.crop, point);
      return;
    }
    if (!this.cropStart) return;
    const x = Math.min(this.cropStart.x, point.x);
    const y = Math.min(this.cropStart.y, point.y);
    this.cropDraft.set({ x, y, width: Math.abs(point.x - this.cropStart.x), height: Math.abs(point.y - this.cropStart.y) });
  }

  protected finishCrop(event: PointerEvent): void {
    if (!this.cropStart && !this.cropResize) return;
    this.updateCrop(event);
    this.cropStart = null;
    this.cropResize = null;
    const canvas = event.currentTarget as HTMLElement;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  protected async applyCropAndProcess(): Promise<void> {
    const crop = this.cropDraft();
    if (crop.width < 0.02 || crop.height < 0.02) {
      this.addDiagnostic('Manual crop', 'Draw a larger rectangle around the marking to scan.');
      return;
    }
    this.applyingCrop.set(true);
    try {
      this.cropRect.set(crop);
      await this.processImage();
    } finally {
      this.applyingCrop.set(false);
    }
  }

  protected async openCamera(): Promise<void> {
    this.clearFields();
    if (!navigator.mediaDevices?.getUserMedia) {
      this.addDiagnostic('Camera', 'This browser does not provide camera access.', 'navigator.mediaDevices.getUserMedia is unavailable.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this.stream = stream;
      this.cameraOpen.set(true);
      afterNextRender(() => {
        const video = this.videoPreview()?.nativeElement;
        if (video && this.stream === stream) {
          video.srcObject = stream;
          void video.play();
        }
      }, { injector: this.injector });
    } catch (error: unknown) {
      this.addDiagnostic('Camera', 'Camera access was not available. Check browser permission and try again.', this.errorMessage(error));
    }
  }

  protected capturePhoto(): void {
    const video = this.videoPreview()?.nativeElement;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      this.addDiagnostic('Camera', 'The camera is not ready yet. Wait for the preview, then capture again.');
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) {
        this.addDiagnostic('Camera', 'The photo could not be created from the camera preview.');
        return;
      }
      this.useImage(blob, `container-${new Date().toISOString().replaceAll(':', '-')}.jpg`);
      this.closeCamera();
    }, 'image/jpeg', 0.92);
  }

  protected closeCamera(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.cameraOpen.set(false);
  }

  protected async setCaptureMode(mode: CaptureMode): Promise<void> {
    if (this.processing() || this.applyingCrop()) return;
    this.captureMode.set(mode);
    if (mode !== 'auto-crop') return;

    const image = this.imageBlob();
    if (!image) return;
    this.clearFields();
    this.cropRect.set(null);
    this.cropDraft.set(DEFAULT_CROP);
    this.clearUnwarpedCropPreview();
    await this.prepareInitialCrop(image, this.imageSelection);
  }

  protected setUnwarpSelectedRegion(enabled: boolean): void {
    if (this.processing() || this.applyingCrop()) return;
    this.unwarpSelectedRegion.set(enabled);
    if (!enabled) {
      this.unwarpRotation.set(0);
      this.clearUnwarpedCropPreview();
    }
  }

  protected setUnwarpRotation(degrees: number): void {
    if (this.processing() || this.applyingCrop()) return;
    this.unwarpRotation.set(Math.max(-10, Math.min(10, degrees)));
    this.clearUnwarpedCropPreview();
  }

  protected retryPreview(failedUrl: string): void {
    const image = this.imageBlob();
    if (!image || this.previewUrl() !== failedUrl) return;

    if (this.previewRetries < MAX_PREVIEW_RETRIES) {
      this.previewRetries++;
      const nextUrl = URL.createObjectURL(image);
      this.previewUrl.set(nextUrl);
      URL.revokeObjectURL(failedUrl);
      this.status.set(`Image preview failed to load. Retrying (${this.previewRetries} of ${MAX_PREVIEW_RETRIES})...`);
      return;
    }

    this.previewUrl.set(null);
    URL.revokeObjectURL(failedUrl);
    this.cancelPreviewLoad(new Error('The selected image preview could not be loaded.'));
    this.addDiagnostic('Image preview', 'The selected image could not be displayed. Choose the image again.');
  }

  protected previewLoaded(url: string): void {
    const pending = this.previewLoad;
    const image = this.previewImage()?.nativeElement;
    if (!pending || pending.selection !== this.imageSelection || this.previewUrl() !== url || !image?.naturalWidth || !image.naturalHeight) {
      return;
    }
    this.previewLoad = null;
    pending.resolve(image);
  }

  protected updateField(key: FieldKey, value: string): void {
    const fieldValue = key === 'containerId' ? value.replace(/[^A-Z0-9]/gi, '').toUpperCase() : value;
    this.fields.update((fields) => {
      const updated = {
        ...fields,
        [key]: { ...fields[key], value: fieldValue },
      };
      return updated;
    });
  }

  protected async processImage(): Promise<void> {
    const image = this.imageBlob();
    if (!image) {
      this.addDiagnostic('Image input', 'Choose or capture a photo before starting OCR.');
      return;
    }
    this.analysisSuccessful.set(false);
    this.processing.set(true);
    this.clearUnwarpedCropPreview();
    this.clearCheckDigitPreview();
    this.selectedOcrLines.set([]);
    this.diagnostics.set([]);
    this.status.set('Preparing local OCR models...');
    const imageUrl = this.previewUrl();
    if (!imageUrl) {
      this.processing.set(false);
      this.addDiagnostic('Image input', 'The selected image preview is unavailable. Choose the image again.');
      return;
    }
    try {
      this.status.set('Loading local PaddleOCR models...');
      this.status.set('Detecting painted text regions...');
      const recovery = { retried: false };
      this.rawText.set([]);
      this.rawScans.set([]);
      const scanResults = await this.scanOcrPasses(image, recovery);
      const lines = this.selectBestOcrLines(scanResults);
      this.selectedOcrLines.set(lines);
      const rawText = lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`);
      this.rawText.set(rawText);
      const fields = this.extractFields(lines);
      this.fields.set(fields);
      if (this.cropRect() && !this.hasValidContainerId(scanResults)) {
        await this.runCheckDigitScan();
      }
      let suggestedCrop: CropRect | null = null;
      if (!this.cropRect()) {
        try {
          suggestedCrop = await this.createSuggestedCrop(lines, fields.containerId.value, image);
        } catch (error: unknown) {
          this.addDiagnostic('Crop suggestion', 'OCR results are ready, but a suggested crop could not be prepared.', this.errorMessage(error));
        }
      }
      if (suggestedCrop) {
        this.cropDraft.set(suggestedCrop);
        this.status.set('OCR complete. Review the suggested region around the container ID and the aligned markings above and below it.');
      } else {
        this.status.set(`OCR complete. Found ${lines.length} text region${lines.length === 1 ? '' : 's'}. Review the fields before saving.`);
      }
      this.analysisSuccessful.set(true);
      this.processing.set(false);
    } catch (error: unknown) {
      this.clearUnwarpedCropPreview();
      this.analysisSuccessful.set(false);
      this.processing.set(false);
      this.addDiagnostic('ONNX OCR', this.ocrFailureMessage(error), this.errorMessage(error));
    }
  }

  protected async saveJsonToIndexedDb(): Promise<void> {
    const image = this.imageBlob();
    if (!image) {
      this.addDiagnostic('IndexedDB', 'Choose or capture an image before saving a record.');
      return;
    }
    try {
      const thumbnail = await this.createThumbnail(image);
      const database = await this.openSavedRecordsDatabase();
      const payload = this.createJsonPayload();
      const id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['records', 'images'], 'readwrite');
        transaction.objectStore('records').add({ id, savedAt: new Date().toISOString(), payload, thumbnail, hasImage: true });
        transaction.objectStore('images').add({ id, image });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      await this.loadSavedRecords();
      this.status.set('Result and photo saved locally in IndexedDB.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'JSON data could not be saved locally.', this.errorMessage(error));
    }
  }

  protected showSavedJson(record: SavedRecord): void {
    this.savedJson.set(JSON.stringify(record.payload, null, 2));
  }

  protected closeSavedJson(): void {
    this.savedJson.set(null);
  }

  protected async viewSavedPhoto(record: SavedRecord): Promise<void> {
    if (!record.hasImage) return;
    try {
      const database = await this.openSavedRecordsDatabase();
      const storedImage = await new Promise<StoredImage | undefined>((resolve, reject) => {
        const transaction = database.transaction('images', 'readonly');
        const request = transaction.objectStore('images').get(record.id);
        request.onsuccess = () => resolve(request.result as StoredImage | undefined);
        request.onerror = () => reject(request.error);
      });
      database.close();
      if (!storedImage?.image) {
        this.addDiagnostic('IndexedDB', 'The saved photo is no longer available.');
        return;
      }
      this.closeSavedPhoto();
      this.savedPhoto.set({ id: record.id, name: this.savedRecordName(record), url: URL.createObjectURL(storedImage.image) });
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'The saved photo could not be loaded.', this.errorMessage(error));
    }
  }

  protected closeSavedPhoto(): void {
    const photo = this.savedPhoto();
    if (photo) URL.revokeObjectURL(photo.url);
    this.savedPhoto.set(null);
  }

  protected async deleteSavedRecord(id: string): Promise<void> {
    try {
      const database = await this.openSavedRecordsDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['records', 'images'], 'readwrite');
        transaction.objectStore('records').delete(id);
        transaction.objectStore('images').delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      this.savedRecords.update((records) => {
        const deleted = records.find((record) => record.id === id);
        if (deleted?.thumbnailUrl) URL.revokeObjectURL(deleted.thumbnailUrl);
        return records.filter((record) => record.id !== id);
      });
      if (this.savedPhoto()?.id === id) this.closeSavedPhoto();
      this.status.set('Saved record deleted.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'The saved record could not be deleted.', this.errorMessage(error));
    }
  }

  protected async deleteAllSavedRecords(): Promise<void> {
    if (!window.confirm('Delete all saved results from this device?')) {
      return;
    }
    try {
      const database = await this.openSavedRecordsDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['records', 'images'], 'readwrite');
        transaction.objectStore('records').clear();
        transaction.objectStore('images').clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      for (const record of this.savedRecords()) {
        if (record.thumbnailUrl) URL.revokeObjectURL(record.thumbnailUrl);
      }
      this.savedRecords.set([]);
      this.savedJson.set(null);
      this.closeSavedPhoto();
      this.status.set('All saved results deleted.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'Saved results could not be deleted.', this.errorMessage(error));
    }
  }

  protected dismissDiagnostics(): void {
    this.diagnostics.set([]);
  }

  protected ngOnDestroy(): void {
    this.closeCamera();
    this.cancelPreviewLoad(new Error('The component was destroyed.'));
    this.clearUnwarpedCropPreview();
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    this.clearUnwarpedCropPreview();
    for (const record of this.savedRecords()) {
      if (record.thumbnailUrl) URL.revokeObjectURL(record.thumbnailUrl);
    }
    this.closeSavedPhoto();
  }

  protected ngOnInit(): void {
    void this.loadSavedRecords();
    const initializationError = this.ocrService.initializationError();
    if (initializationError) {
      this.addDiagnostic('OCR initialization', 'Local OCR could not be initialized. Refresh the app and try again.', initializationError);
    }
  }

  private useImage(image: Blob, name: string): void {
    this.cancelPreviewLoad(new Error('A different image was selected.'));
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    this.imageBlob.set(image);
    this.previewUrl.set(URL.createObjectURL(image));
    this.previewRetries = 0;
    this.sourceName.set(name);
    this.applyingCrop.set(false);
    this.cropRect.set(null);
    this.cropDraft.set(DEFAULT_CROP);
    this.unwarpSelectedRegion.set(false);
    this.unwarpRotation.set(0);
    this.clearCheckDigitPreview();
    this.selectedOcrLines.set([]);
    this.rawText.set([]);
    this.rawScans.set([]);
    const selection = ++this.imageSelection;
    if (this.captureMode() === 'manual-crop') {
      this.status.set('Draw a crop around the ID and markings, then use the selected region to run OCR.');
      return;
    }
    void this.prepareInitialCrop(image, selection);
  }

  private clearFields(): void {
    this.analysisSuccessful.set(false);
    this.fields.set({
      maxWorkingPressureBar: { value: '', unit: 'BAR' },
      maxWorkingPressurePsi: { value: '', unit: 'PSI' },
      containerId: { value: '' },
      isoCode: { value: '' },
      mpgmKg: { value: '', unit: 'KG' },
      mpgmLb: { value: '', unit: 'LB' },
      tareKg: { value: '', unit: 'KG' },
      tareLb: { value: '', unit: 'LB' },
      payloadKg: { value: '', unit: 'KG' },
      payloadLb: { value: '', unit: 'LB' },
      capacityLiters: { value: '', unit: 'L' },
      capacityUsGallons: { value: '', unit: 'US GAL' },
      capacityCubicMeters: { value: '', unit: 'CU.M.' },
      capacityCubicFeet: { value: '', unit: 'CU.FT.' },
    });
    this.rawText.set([]);
    this.rawScans.set([]);
    this.selectedOcrLines.set([]);
    this.clearCheckDigitPreview();
  }

  private async loadSavedRecords(): Promise<void> {
    try {
      const database = await this.openSavedRecordsDatabase();
      const records = await new Promise<StoredRecord[]>((resolve, reject) => {
        const transaction = database.transaction('records', 'readonly');
        const request = transaction.objectStore('records').getAll();
        request.onsuccess = () => resolve(request.result as StoredRecord[]);
        request.onerror = () => reject(request.error);
      });
      database.close();
      for (const record of this.savedRecords()) {
        if (record.thumbnailUrl) URL.revokeObjectURL(record.thumbnailUrl);
      }
      this.savedRecords.set(records
        .sort((first, second) => second.savedAt.localeCompare(first.savedAt))
        .map((record) => this.hydrateSavedRecord(record)));
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'Saved records could not be loaded.', this.errorMessage(error));
    }
  }

  private hydrateSavedRecord(record: StoredRecord): SavedRecord {
    return { ...record, thumbnailUrl: record.thumbnail instanceof Blob ? URL.createObjectURL(record.thumbnail) : null };
  }

  protected savedRecordName(record: SavedRecord): string {
    const source = (record.payload as { source?: { fileName?: unknown } }).source;
    return typeof source?.fileName === 'string' && source.fileName ? source.fileName : 'Container image';
  }

  private async prepareInitialCrop(image: Blob, selection: number): Promise<void> {
    const startedAt = performance.now();
    this.processing.set(true);
    this.status.set('Locating the container ID and markings in the full photo...');
    try {
      const preview = await this.waitForPreviewImage(selection);
      if (selection !== this.imageSelection) return;

      let lines: OcrLine[];
      const scanStartedAt = performance.now();
      try {
        lines = await this.scanAutoCrop(preview, MAX_FULL_PHOTO_PIXELS);
      } catch (error: unknown) {
        this.status.set('Full-photo OCR could not use its normal size. Retrying with a reduced image...');
        try {
          lines = await this.scanAutoCrop(preview, MAX_AUTO_CROP_FALLBACK_PIXELS);
        } catch (fallbackError: unknown) {
          throw new Error(`Normal-size auto crop failed: ${this.errorMessage(error)}. Reduced auto crop failed: ${this.errorMessage(fallbackError)}`);
        }
      }
      this.rawText.set(lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`));
      this.rawScans.set([{
        label: 'Full photo',
        lines: lines.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
        durationMs: Math.round(performance.now() - scanStartedAt),
      }]);
       let fields = this.extractFields(lines);
        const containerId = fields.containerId.value;
        const partialContainerId = /^[A-Z]{3}[UJZ]\d{6}$/.test(containerId)
          ? containerId
          : containerId ? '' : this.findContainerIdAnchor(lines);
      if (partialContainerId) {
        fields.containerId = { value: partialContainerId, confidence: this.containerIdConfidence(lines, partialContainerId) };
      }
      this.fields.set(fields);
      this.analysisSuccessful.set(Boolean(containerId || partialContainerId));
       let suggestedCrop = await this.createSuggestedCrop(lines, containerId || partialContainerId, image, {
         width: preview.naturalWidth,
         height: preview.naturalHeight,
       });
       let automaticRetryReason = '';
        if (suggestedCrop && (this.hasLowConfidence(fields) || Boolean(partialContainerId))) {
          try {
            const retryStartedAt = performance.now();
            automaticRetryReason = partialContainerId && !this.hasLowConfidence(fields)
              ? 'the container ID was incomplete'
              : this.lowConfidenceSummary(fields);
           this.status.set(`Low confidence detected in ${automaticRetryReason}. Retrying the automatic crop at 2x to improve recognition...`);
           const retryLines = await this.scanCropRegion(image, suggestedCrop, 2, MAX_MANUAL_RETRY_CROP_PIXELS, { retried: false });
           this.rawScans.update((scans) => [...scans, {
             label: '2x automatic crop',
             lines: retryLines.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
             durationMs: Math.round(performance.now() - retryStartedAt),
           }]);
           lines = this.selectBestOcrLines([lines, retryLines]);
           this.rawText.set(lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`));
           fields = this.mergeFieldsByConfidence(fields, this.extractFields(retryLines));
           this.fields.set(fields);
            suggestedCrop = await this.createSuggestedCrop(lines, fields.containerId.value || partialContainerId, image, {
              width: preview.naturalWidth,
              height: preview.naturalHeight,
            });
            if (partialContainerId && !this.validateContainerId(fields.containerId.value) && suggestedCrop) {
              this.fields.set(fields);
              this.selectedOcrLines.set(lines);
              await this.runCheckDigitScan(suggestedCrop, lines);
              fields = this.fields();
            }
          } catch (error: unknown) {
           this.addDiagnostic('Automatic crop retry', 'The enlarged automatic crop could not be scanned.', this.errorMessage(error));
         }
       }
       if (selection !== this.imageSelection || this.cropRect()) return;
      const duration = ` (${Math.round(performance.now() - startedAt)} ms)`;
       if (suggestedCrop) {
         this.cropDraft.set(suggestedCrop);
         const retryStatus = automaticRetryReason ? ` Automatic 2x scan completed because ${automaticRetryReason} was below 85%.` : '';
          const completeContainerId = this.validateContainerId(fields.containerId.value);
          this.status.set(completeContainerId
            ? `Container ID located: ${this.formatContainerId(fields.containerId.value)}. Review the suggested crop around it and the aligned markings above and below it.${retryStatus}${duration}`
            : partialContainerId
              ? `Partial container ID located: ${this.formatContainerId(partialContainerId)}${retryStatus}`
              : `Container ID located. Review the suggested crop around it and the aligned markings above and below it.${retryStatus}${duration}`);
      } else if (partialContainerId) {
        this.status.set(`Partial container ID located: ${this.formatContainerId(partialContainerId)}`);
      } else {
        this.status.set(`Container ID was not located. Draw a crop around the ID and markings you want to scan.${duration}`);
      }
    } catch (error: unknown) {
      if (selection === this.imageSelection) {
        this.addDiagnostic('Initial crop detection', 'The ID could not be located automatically. Draw a crop around the markings to scan.', this.errorMessage(error));
      }
    } finally {
      if (selection === this.imageSelection) {
        this.processing.set(false);
      }
    }
  }

  private waitForPreviewImage(selection: number): Promise<HTMLImageElement> {
    const image = this.previewImage()?.nativeElement;
    if (selection === this.imageSelection && image?.src === this.previewUrl() && image.complete && image.naturalWidth && image.naturalHeight) {
      return Promise.resolve(image);
    }
    return new Promise<HTMLImageElement>((resolve, reject) => {
      this.previewLoad = { selection, resolve, reject };
    });
  }

  private cancelPreviewLoad(reason: Error): void {
    const pending = this.previewLoad;
    this.previewLoad = null;
    pending?.reject(reason);
  }

  private async scanAutoCrop(source: HTMLImageElement, maximumPixels: number): Promise<OcrLine[]> {
    const pass = await this.createCropPassFromSource(source, source.naturalWidth, source.naturalHeight, DEFAULT_CROP, 1, undefined, maximumPixels);
    try {
      return this.deduplicateLines((await this.detectWithTimeout(pass.url)).map((line) => ({
        ...line,
        box: line.box?.map(([x, y]) => [x / pass.scale, y / pass.scale]),
      })));
    } finally {
      URL.revokeObjectURL(pass.url);
    }
  }

  private async detectWithRecovery(url: string, recovery: { retried: boolean }) {
    try {
      return await this.detectWithTimeout(url);
    } catch (error: unknown) {
      if (recovery.retried) throw error;
      recovery.retried = true;
      this.status.set('Local OCR stalled. Retrying local OCR once...');
      return this.detectWithTimeout(url);
    }
  }

  private async detectWithTimeout(url: string) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.ocrService.detect(url),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`OCR did not finish within ${OCR_PASS_TIMEOUT_MS / 1000} seconds.`)), OCR_PASS_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private addDiagnostic(stage: string, message: string, technical?: string): void {
    this.status.set(message);
    this.diagnostics.update((diagnostics) => [...diagnostics, { stage, message, technical }]);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async scanCropRegion(image: Blob, crop: CropRect, scale: number, maximumPixels: number, recovery: { retried: boolean }): Promise<OcrLine[]> {
    const pass = await this.createCropPass(image, crop, scale, undefined, maximumPixels);
    try {
      return this.deduplicateLines((await this.detectWithRecovery(pass.url, recovery)).map((line) => ({
        ...line,
        box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
      })));
    } finally {
      if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
    }
  }

  private ocrFailureMessage(error: unknown): string {
    const message = this.errorMessage(error).toLowerCase();
    if (error instanceof RangeError || /memory|allocate|canvas|bitmap|decoded image|webgl/i.test(message)) {
      return 'The browser ran out of memory while preparing this image for OCR. Try a tighter crop or a smaller photo.';
    }
    return 'Local OCR could not process this image.';
  }

  private async scanOcrPasses(image: Blob, recovery: { retried: boolean }): Promise<OcrLine[][]> {
    const manualCrop = this.cropRect();
    const shouldUnwarp = Boolean(manualCrop && this.unwarpSelectedRegion());
    const definitions = manualCrop
      ? [
        { label: 'Original size', crop: manualCrop, scale: 1, maximumPixels: MAX_MANUAL_CROP_PIXELS, unwarp: false, rotation: 0, curvature: 0 },
         { label: shouldUnwarp ? 'Unwarped' : 'Enlarged', crop: manualCrop, scale: shouldUnwarp ? 1 : 2, maximumPixels: MAX_MANUAL_RETRY_CROP_PIXELS, unwarp: shouldUnwarp, rotation: this.unwarpRotation(), curvature: shouldUnwarp ? DEFAULT_AUTO_CURVATURE : 0 },
         ...(shouldUnwarp ? [{ label: '2x unwarped', crop: manualCrop, scale: 2, maximumPixels: MAX_MANUAL_RETRY_CROP_PIXELS, unwarp: true, rotation: this.unwarpRotation(), curvature: DEFAULT_AUTO_CURVATURE }] : []),
       ]
      : [{ label: 'Full photo', crop: DEFAULT_CROP, scale: 1, maximumPixels: MAX_FULL_PHOTO_PIXELS, unwarp: false, rotation: 0, curvature: 0 }];
    const scanResults: OcrLine[][] = [];

    for (const [index, definition] of definitions.entries()) {
      if (definition.unwarp && scanResults[0]?.length) {
        const geometry = this.estimateUnwarpGeometry(scanResults[0]);
        definition.rotation += geometry.rotation;
        definition.curvature = geometry.reliable ? definition.curvature : 0;
      }
      // Release each temporary OCR image before creating the next one.
      const pass = await this.createCropPass(image, definition.crop, definition.scale, undefined, definition.maximumPixels, definition.unwarp, definition.rotation, definition.curvature);
      let retainPass = false;
      try {
        this.status.set(`Scanning ${definition.label}${definitions.length > 1 ? ` (${index + 1} of ${definitions.length})` : ''}...`);
        const startedAt = performance.now();
        const detected = await this.detectWithRecovery(pass.url, recovery);
        if (manualCrop && definition.unwarp && !this.unwarpedCropUrl()) {
          this.unwarpedCropUrl.set(pass.url);
          retainPass = true;
        }
        const scan = detected.map((line) => ({
          ...line,
          box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
         }));
         scanResults.push(scan);
         const lines = this.deduplicateLines(scanResults.flat());
         this.rawText.set(lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`));
         this.rawScans.update((scans) => [...scans, {
          label: definition.label === 'Enlarged' ? `${pass.scale.toFixed(1)}x enlarged` : definition.label,
           lines: scan.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
           durationMs: Math.round(performance.now() - startedAt),
         }]);
         if (manualCrop && !shouldUnwarp && index === 0) {
           if (!this.hasLowConfidence(this.extractFields(scan))) {
             break;
           }
         }
       } finally {
        if (pass.revokeUrl && !retainPass) URL.revokeObjectURL(pass.url);
      }
    }

    return scanResults;
  }

  private estimateUnwarpGeometry(lines: OcrLine[]): UnwarpGeometry {
    const angles = lines
      .filter((line) => line.mean >= 0.5 && line.box && line.box.length >= 4)
      .map((line) => {
        const box = line.box!;
        let longest: number[][] = [];
        for (let index = 0; index < box.length; index++) {
          const edge = [box[index], box[(index + 1) % box.length]];
          const longestWidth = longest.length === 2 ? Math.abs(longest[1][0] - longest[0][0]) : 0;
          if (Math.abs(edge[1][0] - edge[0][0]) > longestWidth) longest = edge;
        }
        return Math.atan2(longest[1][1] - longest[0][1], longest[1][0] - longest[0][0]) * 180 / Math.PI;
      })
      .filter((angle) => Number.isFinite(angle) && Math.abs(angle) <= 20)
      .sort((first, second) => first - second);
    if (angles.length < 2) return { rotation: 0, curvature: 0, reliable: false };
    const median = angles[Math.floor(angles.length / 2)];
    return { rotation: Math.max(-10, Math.min(10, -median)), curvature: DEFAULT_AUTO_CURVATURE, reliable: true };
  }

  private clearUnwarpedCropPreview(): void {
    const url = this.unwarpedCropUrl();
    if (url) URL.revokeObjectURL(url);
    this.unwarpedCropUrl.set(null);
  }

  private async runCheckDigitScan(crop = this.cropRect(), lines = this.selectedOcrLines()): Promise<void> {
    const image = this.imageBlob();
    if (!image || !crop) return;
    const imageSize = this.previewImage()?.nativeElement;
    if (!imageSize?.naturalWidth || !imageSize.naturalHeight) {
      this.addDiagnostic('Check digit OCR', 'The source image dimensions are not available yet.');
      return;
    }
    const region = this.checkDigitRegion(lines, imageSize.naturalWidth, imageSize.naturalHeight, crop);
    if (!region) {
      this.addDiagnostic('Check digit OCR', 'The first 10 container-ID characters could not define a check-digit region.');
      return;
    }

    this.processing.set(true);
    const startedAt = performance.now();
    let retainPass = false;
    let pass: { url: string; revokeUrl: boolean } | null = null;
    try {
      this.status.set('Scanning the expected check-digit region...');
      pass = await this.createCheckDigitPass(image, region);
      this.clearCheckDigitPreview();
      this.checkDigitPreviewUrl.set(pass.url);
      retainPass = true;
      const detected = await this.detectWithRecovery(pass.url, { retried: false });
      const scan = detected.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) }));
      this.rawScans.update((scans) => [...scans, {
        label: 'Check-digit region',
        lines: scan,
        durationMs: Math.round(performance.now() - startedAt),
      }]);
      this.applyCheckDigitCandidate(lines, detected);
      this.status.set('Check-digit scan complete.');
    } catch (error: unknown) {
      this.addDiagnostic('Check digit OCR', 'The targeted check-digit scan could not be completed.', this.errorMessage(error));
    } finally {
      if (pass?.revokeUrl && !retainPass) URL.revokeObjectURL(pass.url);
      this.processing.set(false);
    }
  }

  private applyCheckDigitCandidate(lines: OcrLine[], detected: OcrLine[]): void {
    const stem = this.findCheckDigitStem(lines);
    if (!stem) return;
    const current = this.fields().containerId;
    const candidates = detected
      .map((line) => {
        const digits = line.text.match(/\d/g) ?? [];
        return { digit: digits.length === 1 ? digits[0] : undefined, confidence: line.mean };
      })
      .filter((item): item is { digit: string; confidence: number } => Boolean(item.digit))
      .sort((first, second) => second.confidence - first.confidence);
    const candidate = candidates.find((item) => this.validateContainerId(stem + item.digit));
    const recoveredDigit = candidate?.digit ?? (candidates.length ? this.containerIdCheckDigit(stem) : null);
    if (!recoveredDigit) return;
    const recoveredConfidence = candidate?.confidence ?? candidates[0].confidence;
    if (this.validateContainerId(current.value) && recoveredConfidence < (current.confidence ?? 0)) return;
    this.fields.update((fields) => ({
      ...fields,
      containerId: { ...fields.containerId, value: stem + recoveredDigit, confidence: recoveredConfidence },
    }));
  }

  private hasValidContainerId(results: OcrLine[][]): boolean {
    return results.some((lines) => this.validateContainerId(this.extractFields(lines).containerId.value));
  }

  private findCheckDigitStem(lines: OcrLine[]): string {
    const value = this.fields().containerId.value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (/^[A-Z]{3}[UJZ]\d{6}/.test(value)) return value.slice(0, 10);
    return this.findContainerIdAnchor(lines);
  }

  private checkDigitRegion(lines: OcrLine[], imageWidth: number, imageHeight: number, crop = this.cropRect()): CropRect | null {
    const stem = this.findCheckDigitStem(lines);
    if (!stem) return null;
    const stemLines = this.linesForCheckDigitStem(lines, stem);
    const idBounds = this.combineBounds(stemLines
      .map((line) => this.boxBounds(line.box))
      .filter((bounds): bounds is BoxBounds => Boolean(bounds)));
    if (!idBounds || !crop) return null;
    const cropBounds = {
      left: crop.x * imageWidth,
      top: crop.y * imageHeight,
      right: (crop.x + crop.width) * imageWidth,
      bottom: (crop.y + crop.height) * imageHeight,
    };
    const idWidth = Math.max(1, idBounds.right - idBounds.left);
    const anchor = stemLines.find((line) => line.box?.length && line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(stem));
    const normalizedAnchor = anchor?.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const anchorBounds = anchor ? this.boxBounds(anchor.box) : null;
    const stemRight = anchor && normalizedAnchor
      ? anchorBounds!.left + (anchorBounds!.right - anchorBounds!.left) * ((normalizedAnchor.indexOf(stem) + stem.length) / normalizedAnchor.length)
      : idBounds.right;
    const characterWidth = Math.max(1, (stemRight - idBounds.left) / 10);
    const left = Math.max(cropBounds.left, stemRight - characterWidth * 1.5);
    const right = Math.min(cropBounds.right, stemRight + characterWidth * 2.8);
    const top = Math.max(cropBounds.top, idBounds.top);
    const bottom = Math.min(cropBounds.bottom, idBounds.bottom);
    if (right <= left || bottom <= top) return null;
    return { x: left / imageWidth, y: top / imageHeight, width: (right - left) / imageWidth, height: (bottom - top) / imageHeight };
  }

  private linesForCheckDigitStem(lines: OcrLine[], stem: string): OcrLine[] {
    const fragments = lines
      .map((line, index) => ({ line, index, text: line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase(), bounds: this.boxBounds(line.box) }))
      .filter((fragment) => fragment.text && fragment.bounds)
      .sort((first, second) => first.bounds!.top - second.bounds!.top || first.bounds!.left - second.bounds!.left);
    for (let start = 0; start < fragments.length; start++) {
      for (let length = 1; length <= 3 && start + length <= fragments.length; length++) {
        const candidate = fragments.slice(start, start + length);
        if (!candidate.map((fragment) => fragment.text).join('').includes(stem)) continue;
        const centers = candidate.map((fragment) => (fragment.bounds!.top + fragment.bounds!.bottom) / 2);
        const heights = candidate.map((fragment) => fragment.bounds!.bottom - fragment.bounds!.top);
        const baselineTolerance = Math.max(6, Math.min(...heights) * 0.75);
        if (Math.max(...centers) - Math.min(...centers) <= baselineTolerance) {
          return candidate.map((fragment) => fragment.line);
        }
      }
    }
    return [];
  }

  private async createCheckDigitPass(image: Blob, region: CropRect): Promise<{ url: string; revokeUrl: boolean }> {
    const decodedImage = await this.decodeImage(image);
    try {
      const sourceX = Math.round(region.x * decodedImage.width);
      const sourceY = Math.round(region.y * decodedImage.height);
      const sourceWidth = Math.max(1, Math.round(region.width * decodedImage.width));
      const sourceHeight = Math.max(1, Math.round(region.height * decodedImage.height));
      const scale = this.cropOutputScale(sourceWidth, sourceHeight, 3, undefined, this.runtimeCropPixelBudget(MAX_CHECK_DIGIT_CROP_PIXELS));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable.');
        context.drawImage(decodedImage.source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Check-digit crop could not be created.')), 'image/png'));
        return { url: URL.createObjectURL(blob), revokeUrl: true };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      decodedImage.release();
    }
  }

  private clearCheckDigitPreview(): void {
    const url = this.checkDigitPreviewUrl();
    if (url) URL.revokeObjectURL(url);
    this.checkDigitPreviewUrl.set(null);
  }

  private selectBestOcrLines(results: OcrLine[][]): OcrLine[] {
    return results
      .map((result) => this.deduplicateLines(result))
      .sort((first, second) => this.ocrResultScore(second) - this.ocrResultScore(first))[0] ?? [];
  }

  private mergeFieldsByConfidence(original: Record<FieldKey, ContainerField>, retry: Record<FieldKey, ContainerField>): Record<FieldKey, ContainerField> {
    const merged = { ...original };
    for (const key of Object.keys(original) as FieldKey[]) {
      const candidate = retry[key];
      const current = original[key];
      if (candidate?.value && (!current.value || (candidate.confidence ?? 0) > (current.confidence ?? 0))) {
        merged[key] = { ...current, ...candidate };
      }
    }
    return merged;
  }

  private lowConfidenceSummary(fields: Record<string, ContainerField>): string {
    const labels: Record<string, string> = {
      mpgmKg: 'MGW',
      mpgmLb: 'MGW',
      tareKg: 'TARE',
      tareLb: 'TARE',
      payloadKg: 'PAYLOAD',
      payloadLb: 'PAYLOAD',
      capacityLiters: 'CAPACITY',
      capacityUsGallons: 'CAPACITY',
      capacityCubicMeters: 'CAPACITY',
      capacityCubicFeet: 'CAPACITY',
    };
    return Object.entries(fields)
      .filter(([, field]) => field.value && field.confidence !== undefined && field.confidence < 0.85)
      .map(([key, field]) => `${labels[key] ?? key} ${Math.round((field.confidence ?? 0) * 100)}%`)
      .join(', ');
  }

  private hasLowConfidence(fields: Record<string, ContainerField>): boolean {
    return Object.values(fields).some((field) => field.value && field.confidence !== undefined && field.confidence < 0.85);
  }

  private ocrResultScore(lines: OcrLine[]): number {
    const fields = this.extractFields(lines);
    const detectedFields = Object.values(fields).filter((field) => field.value).length;
    const confidence = lines.reduce((total, line) => total + line.mean, 0);
    return detectedFields * 10
      + (fields.containerId.value ? 100 : 0)
      + (this.validateContainerId(fields.containerId.value) ? 100 : 0)
      + confidence;
  }

  private cropPoint(event: PointerEvent): { x: number; y: number } | null {
    const canvas = (event.currentTarget as HTMLElement).closest('.crop-canvas');
    const image = canvas?.querySelector('img');
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  private resizeCrop(handle: CropResizeHandle, crop: CropRect, point: { x: number; y: number }): void {
    const minimumSize = 0.02;
    let left = crop.x;
    let top = crop.y;
    let right = crop.x + crop.width;
    let bottom = crop.y + crop.height;
    if (handle === 'top-left' || handle === 'bottom-left') {
      left = Math.max(0, Math.min(point.x, right - minimumSize));
    } else {
      right = Math.min(1, Math.max(point.x, left + minimumSize));
    }
    if (handle === 'top-left' || handle === 'top-right') {
      top = Math.max(0, Math.min(point.y, bottom - minimumSize));
    } else {
      bottom = Math.min(1, Math.max(point.y, top + minimumSize));
    }
    this.cropDraft.set({ x: left, y: top, width: right - left, height: bottom - top });
  }

  protected cropResizeHandleLabel(handle: CropResizeHandle): string {
    return `Resize crop from ${handle.replace('-', ' ')}`;
  }

  private async createSuggestedCrop(lines: OcrLine[], containerId: string, image: Blob, sourceSize?: { width: number; height: number }): Promise<CropRect | null> {
    const markingsBounds = this.suggestedMarkingBounds(lines, containerId);
    if (!markingsBounds) return null;

    const decodedImage = sourceSize ? null : await this.decodeImage(image);
    const width = sourceSize?.width ?? decodedImage!.width;
    const height = sourceSize?.height ?? decodedImage!.height;
    try {
      const padding = Math.max(24, Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top) * 0.08);
      const left = Math.max(0, markingsBounds.left - padding);
      const top = Math.max(0, markingsBounds.top - padding);
      const right = Math.min(width, markingsBounds.right + padding);
      const bottom = Math.min(height, markingsBounds.bottom + padding);
      return {
        x: left / width,
        y: top / height,
        width: (right - left) / width,
        height: (bottom - top) / height,
      };
    } finally {
      decodedImage?.release();
    }
  }

  private suggestedMarkingBounds(lines: OcrLine[], containerId: string): BoxBounds | null {
    const cropAnchor = containerId || this.findContainerIdAnchor(lines);
    if (!cropAnchor) return null;
    const isIncompleteIdAnchor = !containerId;
    const idLines = this.linesForContainerId(lines, cropAnchor);
    const idBounds = this.combineBounds(idLines.map((line) => this.boxBounds(line.box)).filter((bounds): bounds is BoxBounds => Boolean(bounds)));
    if (!idBounds) return null;

    const idHeight = idBounds.bottom - idBounds.top;
    const relevantBounds = lines
      .map((line) => this.boxBounds(line.box))
      .filter((bounds): bounds is BoxBounds => Boolean(bounds))
      .filter((bounds) => bounds.bottom <= idBounds.top || bounds.top >= idBounds.bottom)
      .filter((bounds) => bounds.right >= idBounds.left && bounds.left <= idBounds.right);
    const markingsBounds = this.combineBounds([idBounds, ...relevantBounds]);
    if (!markingsBounds) return null;
    const right = isIncompleteIdAnchor
      ? idBounds.right + (idBounds.right - idBounds.left) / 10
      : idBounds.right;
    return { left: idBounds.left, top: markingsBounds.top, right, bottom: markingsBounds.bottom };
  }

  private findContainerIdAnchor(lines: OcrLine[]): string {
    const fragments = lines
      .map((line, index) => ({
        line,
        index,
        text: line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
        bounds: this.boxBounds(line.box),
      }))
      .filter((fragment) => fragment.text && fragment.bounds && this.isLikelySingleOcrRow(fragment.line, lines))
      .sort((first, second) => first.bounds!.top - second.bounds!.top || first.bounds!.left - second.bounds!.left);
    let partialAnchor = '';
    for (let start = 0; start < fragments.length; start++) {
      for (let length = 1; length <= 3 && start + length <= fragments.length; length++) {
        const candidateFragments = fragments.slice(start, start + length);
        if (!candidateFragments.every((fragment) => this.sameOcrRow(candidateFragments[0], fragment))) continue;
        const candidate = candidateFragments.map((fragment) => fragment.text).join('');
        const compactCandidate = candidate.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const candidatePattern = candidateFragments.length === 1
          ? /[A-Z]{3}[UJZ]\d{7}/g
          : /^[A-Z]{3}[UJZ]\d{7}$/;
        const fullMatch = compactCandidate.match(candidatePattern)?.find((value) => this.validateContainerId(value));
        if (fullMatch) return fullMatch.slice(0, 10);
        const partialPattern = candidateFragments.length === 1
          ? /[A-Z]{3}[UJZ]\d{6}/
          : /^[A-Z]{3}[UJZ]\d{6}$/;
        const partialMatch = compactCandidate.match(partialPattern)?.[0];
        if (partialMatch && !partialAnchor) partialAnchor = partialMatch;
      }
    }
    return partialAnchor;
  }

  private containerIdConfidence(lines: OcrLine[], containerId: string): number | undefined {
    const normalizedId = containerId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return lines
      .filter((line) => line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(normalizedId))
      .sort((first, second) => second.mean - first.mean)[0]?.mean;
  }

  private linesForContainerId(lines: OcrLine[], containerId: string): OcrLine[] {
    const normalizedId = containerId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const fragments = lines
      .map((line, index) => ({
        line,
        index,
        text: line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
        bounds: this.boxBounds(line.box),
      }))
      .filter((fragment) => fragment.text && fragment.bounds)
      .sort((first, second) => first.bounds!.top - second.bounds!.top || first.bounds!.left - second.bounds!.left);
    for (let start = 0; start < fragments.length; start++) {
      for (let length = 1; length <= 3 && start + length <= fragments.length; length++) {
        const candidate = fragments.slice(start, start + length);
        if (!candidate.every((fragment) => this.sameOcrRow(candidate[0], fragment))) continue;
        if (candidate.map((fragment) => fragment.text).join('').includes(normalizedId)) {
          return candidate.map((fragment) => this.narrowLineToContainerId(fragment.line, normalizedId));
        }
      }
    }
    return [];
  }

  private boxBounds(box: number[][] | undefined): BoxBounds | null {
    if (!box?.length) return null;
    const xs = box.map(([x]) => x);
    const ys = box.map(([, y]) => y);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  }

  private combineBounds(bounds: BoxBounds[]): BoxBounds | null {
    if (!bounds.length) return null;
    return {
      left: Math.min(...bounds.map((bound) => bound.left)),
      top: Math.min(...bounds.map((bound) => bound.top)),
      right: Math.max(...bounds.map((bound) => bound.right)),
      bottom: Math.max(...bounds.map((bound) => bound.bottom)),
    };
  }

  private async createCropPass(image: Blob, crop: CropRect, scale: number, maximumWidth?: number, maximumPixels?: number, unwarp = false, rotation = 0, curvature = 0): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean }> {
    const decodedImage = await this.decodeImage(image);
    try {
      return await this.createCropPassFromSource(decodedImage.source, decodedImage.width, decodedImage.height, crop, scale, maximumWidth, maximumPixels, unwarp, rotation, curvature);
    } finally {
      decodedImage.release();
    }
  }

  private async createThumbnail(image: Blob): Promise<Blob> {
    const decodedImage = await this.decodeImage(image);
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(decodedImage.width, decodedImage.height));
    const canvas = document.createElement('canvas');
    try {
      canvas.width = Math.max(1, Math.round(decodedImage.width * scale));
      canvas.height = Math.max(1, Math.round(decodedImage.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable.');
      context.drawImage(decodedImage.source, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('Thumbnail could not be created.'));
      }, 'image/jpeg', THUMBNAIL_JPEG_QUALITY));
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      decodedImage.release();
    }
  }

  private async createCropPassFromSource(source: CanvasImageSource, imageWidth: number, imageHeight: number, crop: CropRect, scale: number, maximumWidth?: number, maximumPixels?: number, unwarp = false, rotation = 0, curvature = 0): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean }> {
    const sourceX = Math.round(crop.x * imageWidth);
    const sourceY = Math.round(crop.y * imageHeight);
    const sourceWidth = Math.max(1, Math.round(crop.width * imageWidth));
    const sourceHeight = Math.max(1, Math.round(crop.height * imageHeight));
    const outputScale = this.cropOutputScale(sourceWidth, sourceHeight, scale, maximumWidth, this.runtimeCropPixelBudget(maximumPixels));
    const baseWidth = Math.max(1, Math.round(sourceWidth * outputScale));
    const baseHeight = Math.max(1, Math.round(sourceHeight * outputScale));
    const radians = unwarp ? rotation * Math.PI / 180 : 0;
    const outputWidth = Math.max(1, Math.ceil(Math.abs(baseWidth * Math.cos(radians)) + Math.abs(baseHeight * Math.sin(radians))));
    const outputHeight = Math.max(1, Math.ceil(Math.abs(baseWidth * Math.sin(radians)) + Math.abs(baseHeight * Math.cos(radians))));
    const canvas = document.createElement('canvas');
    try {
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable.');
      if (unwarp) {
        this.drawCylindricalUnwarp(context, source, sourceX, sourceY, sourceWidth, sourceHeight, baseWidth, baseHeight, canvas.width, canvas.height, radians, curvature);
      } else {
        context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, baseWidth, baseHeight);
      }
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('Manual crop could not be created.'));
      }, 'image/png'));
      return { url: URL.createObjectURL(blob), offsetX: sourceX, offsetY: sourceY, scale: outputScale, revokeUrl: true };
    } finally {
      // Reset dimensions to release this large backing store before the next image pass.
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  private narrowLineToContainerId(line: OcrLine, containerId: string): OcrLine {
    const source = line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const target = containerId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const start = source.indexOf(target);
    const bounds = this.boxBounds(line.box);
    if (start < 0 || !bounds || !source.length) return line;
    const left = bounds.left + (bounds.right - bounds.left) * start / source.length;
    const right = bounds.left + (bounds.right - bounds.left) * (start + target.length) / source.length;
    return {
      ...line,
      box: [[left, bounds.top], [right, bounds.top], [right, bounds.bottom], [left, bounds.bottom]],
    };
  }

  private isLikelySingleOcrRow(line: OcrLine, lines: OcrLine[]): boolean {
    const bounds = this.boxBounds(line.box);
    if (!bounds) return false;
    const heights = lines
      .map((candidate) => this.boxBounds(candidate.box))
      .filter((candidate): candidate is BoxBounds => Boolean(candidate))
      .map((candidate) => candidate.bottom - candidate.top)
      .sort((first, second) => first - second);
    if (!heights.length) return true;
    const medianHeight = heights[Math.floor((heights.length - 1) / 2)];
    return bounds.bottom - bounds.top <= medianHeight * 1.75;
  }

  private sameOcrRow(first: { bounds: BoxBounds | null }, second: { bounds: BoxBounds | null }): boolean {
    if (!first.bounds || !second.bounds) return false;
    const firstHeight = first.bounds.bottom - first.bounds.top;
    const secondHeight = second.bounds.bottom - second.bounds.top;
    const firstCenter = (first.bounds.top + first.bounds.bottom) / 2;
    const secondCenter = (second.bounds.top + second.bounds.bottom) / 2;
    return Math.abs(firstCenter - secondCenter) <= Math.min(firstHeight, secondHeight) * 0.5;
  }

  private drawCylindricalUnwarp(context: CanvasRenderingContext2D, source: CanvasImageSource, sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number, baseWidth: number, baseHeight: number, outputWidth: number, outputHeight: number, rotation: number, curvature: number): void {
    // Approximate a vertical cylinder by mapping horizontal strips from the projected arc.
    const halfAngle = (Math.PI / 2) * Math.min(0.9, Math.abs(curvature));
    const edgeSin = Math.sin(halfAngle);
    const segments = Math.min(CYLINDER_UNWARP_MAX_SEGMENTS, Math.max(32, Math.ceil(baseWidth / 8)));
    const sourceAt = (outputX: number) => {
      const normalized = outputX / baseWidth * 2 - 1;
      if (Math.abs(curvature) < 0.001) return sourceX + ((normalized + 1) / 2) * sourceWidth;
      const projected = Math.sin(normalized * halfAngle) / edgeSin;
      return sourceX + ((projected + 1) / 2) * sourceWidth;
    };

    context.save();
    context.translate(outputWidth / 2, outputHeight / 2);
    context.rotate(rotation);
    for (let segment = 0; segment < segments; segment++) {
      const outputLeft = Math.round(segment * baseWidth / segments);
      const outputRight = Math.round((segment + 1) * baseWidth / segments);
      const sourceLeft = sourceAt(outputLeft);
      const sourceRight = sourceAt(outputRight);
      const normalized = ((outputLeft + outputRight) / 2) / baseWidth * 2 - 1;
      const verticalShift = curvature * normalized * normalized * baseHeight * 0.08;
      context.drawImage(
        source,
        sourceLeft,
        sourceY,
        Math.max(1, sourceRight - sourceLeft),
        sourceHeight,
        outputLeft - baseWidth / 2,
        -baseHeight / 2 + verticalShift,
        Math.max(1, outputRight - outputLeft),
        outputHeight,
      );
    }
    context.restore();
  }

  private cropOutputScale(sourceWidth: number, sourceHeight: number, requestedScale: number, maximumWidth?: number, maximumPixels?: number): number {
    const widthScale = maximumWidth ? maximumWidth / sourceWidth : Number.POSITIVE_INFINITY;
    const pixelScale = maximumPixels ? Math.sqrt(maximumPixels / (sourceWidth * sourceHeight)) : Number.POSITIVE_INFINITY;
    return Math.min(requestedScale, widthScale, pixelScale);
  }

  private runtimeCropPixelBudget(configuredMaximumPixels?: number): number | undefined {
    if (!configuredMaximumPixels || typeof performance === 'undefined') return configuredMaximumPixels;

    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (!memory || !Number.isFinite(memory.usedJSHeapSize) || !Number.isFinite(memory.jsHeapSizeLimit)) {
      return configuredMaximumPixels;
    }

    // Keep most free heap available for the source image, OCR worker, and other transient buffers.
    const availableBytes = Math.max(0, memory.jsHeapSizeLimit - memory.usedJSHeapSize);
    const availablePixels = Math.max(1, Math.floor((availableBytes * CROP_MEMORY_HEADROOM) / CROP_BYTES_PER_PIXEL));
    return Math.min(configuredMaximumPixels, availablePixels);
  }

  private async decodeImage(image: Blob): Promise<DecodedImage> {
    let bitmapError: unknown;
    try {
      const bitmap = await createImageBitmap(image);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch (error: unknown) {
      bitmapError = error;
    }
    let imageError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = URL.createObjectURL(image);
      const element = new Image();
      try {
        const loaded = new Promise<void>((resolve, reject) => {
          element.onload = () => resolve();
          element.onerror = () => reject(new Error('The browser image element reported a load failure.'));
        });
        element.src = url;
        await loaded;
        // Some mobile browsers display an image successfully but reject decode().
        // A load event with dimensions is sufficient for Canvas rendering.
        try {
          await element.decode();
        } catch {
          // Use the successfully loaded image element as the Canvas source.
        }
        if (!element.naturalWidth || !element.naturalHeight) {
          throw new Error('The source image has no decodable dimensions.');
        }
        return {
          source: element,
          width: element.naturalWidth,
          height: element.naturalHeight,
          release: () => URL.revokeObjectURL(url),
        };
      } catch (error: unknown) {
        URL.revokeObjectURL(url);
        imageError = error;
      }
    }
    const details = [
      `type=${image.type || 'unknown'}`,
      `size=${Math.round(image.size / 1024)}KiB`,
      `ImageBitmap=${this.errorMessage(bitmapError)}`,
      `HTMLImage=${this.errorMessage(imageError)}`,
    ].join(', ');
    throw new Error(`Unable to decode the source image (${details}).`);
  }

  private deduplicateLines(lines: OcrLine[]): OcrLine[] {
    const retained: OcrLine[] = [];
    for (const line of lines) {
      const normalized = line.text.replace(/\s/g, '').toUpperCase();
      const duplicate = retained.find((existing) => existing.text.replace(/\s/g, '').toUpperCase() === normalized);
      if (!duplicate) {
        retained.push(line);
      } else if (line.mean > duplicate.mean) {
        retained[retained.indexOf(duplicate)] = line;
      }
    }
    return retained;
  }

  private createJsonPayload() {
    const fields = this.fields();
    const warnings = this.diagnostics().map((diagnostic) => `${diagnostic.stage}: ${diagnostic.message}`);
    if (fields.containerId.value && !this.containerIdValid()) {
      warnings.push('Container ID does not pass ISO 6346 format and check-digit validation.');
    }
    return {
      source: {
        fileName: this.sourceName(),
        processedAt: new Date().toISOString(),
        manualCrop: this.cropRect(),
      },
      container: {
        maxWorkingPressure: { bar: fields.maxWorkingPressureBar, psi: fields.maxWorkingPressurePsi },
        id: { ...fields.containerId, iso6346Valid: this.containerIdValid() },
        isoCode: fields.isoCode,
        mpgm: { kg: fields.mpgmKg, lb: fields.mpgmLb },
        tare: { kg: fields.tareKg, lb: fields.tareLb },
        payload: { kg: fields.payloadKg, lb: fields.payloadLb },
        capacity: {
          liters: fields.capacityLiters,
          usGallons: fields.capacityUsGallons,
          cubicMeters: fields.capacityCubicMeters,
          cubicFeet: fields.capacityCubicFeet,
        },
      },
      warnings,
      rawText: this.rawText(),
    };
  }

  private openSavedRecordsDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('container-mark-reader', 2);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        const transaction = request.transaction;
        if (!database.objectStoreNames.contains('records')) {
          database.createObjectStore('records', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('images')) {
          database.createObjectStore('images', { keyPath: 'id' });
        }
        if (event.oldVersion < 2 && transaction) {
          const records = transaction.objectStore('records');
          const images = transaction.objectStore('images');
          records.openCursor().onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            const record = cursor.value as StoredRecord;
            if (record.image instanceof Blob) {
              images.put({ id: record.id, image: record.image });
              delete record.image;
              record.hasImage = true;
              cursor.update(record);
            }
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private extractFields(lines: OcrLine[]): Record<FieldKey, ContainerField> {
    const fields: Record<FieldKey, ContainerField> = {
      maxWorkingPressureBar: { value: '', unit: 'BAR' }, maxWorkingPressurePsi: { value: '', unit: 'PSI' },
      containerId: { value: '' }, isoCode: { value: '' },
      mpgmKg: { value: '', unit: 'KG' }, mpgmLb: { value: '', unit: 'LB' },
      tareKg: { value: '', unit: 'KG' }, tareLb: { value: '', unit: 'LB' },
      payloadKg: { value: '', unit: 'KG' }, payloadLb: { value: '', unit: 'LB' },
      capacityLiters: { value: '', unit: 'L' },
      capacityUsGallons: { value: '', unit: 'US GAL' },
      capacityCubicMeters: { value: '', unit: 'CU.M.' },
      capacityCubicFeet: { value: '', unit: 'CU.FT.' },
    };
    const text = lines.map((line) => ({ ...line, normalized: line.text.toUpperCase().replace(/[|]/g, 'I') }));
    const find = (pattern: RegExp) => text.find((line) => pattern.test(line.normalized));
    const idCandidates = text.flatMap((line) => {
      const match = line.normalized.match(/\b([A-Z]{3}[UJZ])\s*((?:\d\s*){5}\d)\s*(\d)?\b/);
      if (!match) return [];
      const stem = `${match[1]}${match[2].replace(/\s/g, '')}`;
      const checkDigit = match[3] ?? '';
      return [{ line, stem, value: checkDigit ? `${stem}${checkDigit}` : '' }];
    });
    const validId = idCandidates.find((candidate) => candidate.value && this.validateContainerId(candidate.value));
    if (validId) {
      fields.containerId = { value: validId.value, confidence: validId.line.mean };
    } else {
      const idFragments = text
        .map((line, index) => ({
          ...line,
          index,
          fragment: line.normalized.replace(/[^A-Z0-9]/g, ''),
          bounds: this.boxBounds(line.box),
        }))
        .filter((line) => line.fragment && line.bounds)
        .sort((first, second) => first.bounds!.top - second.bounds!.top || first.bounds!.left - second.bounds!.left);
      const sameRow = (first: typeof idFragments[number], second: typeof idFragments[number]) => {
        const firstBounds = first.bounds!;
        const secondBounds = second.bounds!;
        return this.sameOcrRow(first, second);
      };
      for (let start = 0; start < idFragments.length && !fields.containerId.value; start++) {
        for (let length = 2; length <= 3 && start + length <= idFragments.length; length++) {
          const candidate = idFragments.slice(start, start + length);
          if (!candidate.every((line) => sameRow(candidate[0], line))) continue;
          const compactCandidate = candidate.map((line) => line.fragment).join('').toUpperCase();
          const recovered = compactCandidate.match(/^[A-Z]{3}[UJZ]\d{7}$/)?.[0];
          if (recovered && this.validateContainerId(recovered)) {
            fields.containerId = {
              value: recovered,
              confidence: Math.min(...candidate.map((line) => line.mean)),
            };
            break;
          }
        }
      }
    }
    const isoLine = find(/\b[0-9]{2}[A-Z][0-9A-Z]\b/);
    if (isoLine) {
      fields.isoCode = { value: isoLine.normalized.match(/\b[0-9]{2}[A-Z][0-9A-Z]\b/)![0], confidence: isoLine.mean };
    }

    const weightAfter = (label: RegExp, unit: 'KG' | 'LB') => {
      const parseWeight = (line: OcrLine & { normalized: string }, source = line.normalized): { value: string; confidence: number; inferred?: boolean } | undefined => {
        const explicitWeights = /(?<value>\d[\d ,.]*?)\s*(?<unit>KG|LBS?)/g;
        for (const match of source.matchAll(explicitWeights)) {
          const firstUnit = match.groups?.['unit']?.startsWith('K') ? 'KG' : 'LB';
          if (firstUnit === unit) {
            return { value: match.groups?.['value']?.trim() ?? '', confidence: line.mean };
          }
          const end = (match.index ?? 0) + match[0].length;
          const paired = source.slice(end).match(/^\s*\/\s*(\d[\d ,.]*?)\s*([A-Z]+)/);
          if (!paired) continue;
          const readableUnit = paired[2] === 'KG' ? 'KG' : /^(?:LB|LBS)$/.test(paired[2]) ? 'LB' : undefined;
          const pairedUnit = readableUnit ?? (firstUnit === 'KG' ? 'LB' : 'KG');
          if (pairedUnit === unit) {
            return { value: paired[1].trim(), confidence: line.mean, inferred: !readableUnit };
          }
        }
        return undefined;
      };
      const labeledWeight = text
        .map((line) => {
          const labelMatch = line.normalized.match(label);
          const source = labelMatch?.index === undefined
            ? undefined
            : line.normalized.slice(labelMatch.index + labelMatch[0].length);
          return { line, match: source === undefined ? undefined : parseWeight(line, source) };
        })
        .filter(({ match }) => match)
        .sort((first, second) => second.line.mean - first.line.mean)[0];
      if (labeledWeight?.match) {
        return labeledWeight.match;
      }
      const labelIndex = text.findIndex((line) => label.test(line.normalized));
      if (labelIndex < 0) return undefined;
      const labelLine = text[labelIndex];
      const center = (line: OcrLine) => {
        if (!line.box?.length) return undefined;
        const [x, y] = line.box.reduce(([totalX, totalY], [pointX, pointY]) => [totalX + pointX, totalY + pointY], [0, 0]);
        return [x / line.box.length, y / line.box.length] as const;
      };
      const labelCenter = center(labelLine);
      if (labelCenter) {
        const closestWeight = text
          .map((line) => ({ line, match: parseWeight(line), center: center(line) }))
          .filter(({ match, center }) => match && center)
          .sort((first, second) => {
            // Container markings list a label before its weight rows; an earlier row belongs to the preceding label.
            const firstAboveLabel = first.center![1] < labelCenter[1] - 4;
            const secondAboveLabel = second.center![1] < labelCenter[1] - 4;
            if (firstAboveLabel !== secondAboveLabel) return firstAboveLabel ? 1 : -1;
            const firstDistance = Math.abs(first.center![1] - labelCenter[1]) * 10 + Math.abs(first.center![0] - labelCenter[0]);
            const secondDistance = Math.abs(second.center![1] - labelCenter[1]) * 10 + Math.abs(second.center![0] - labelCenter[0]);
            return firstDistance - secondDistance;
          })[0];
        if (closestWeight?.match) {
          return closestWeight.match;
        }
      }
      const nearby = text.slice(labelIndex);
      for (const line of nearby) {
        const match = parseWeight(line);
        if (match) {
          return match;
        }
      }
      return undefined;
    };
    const capacityAfter = (label: RegExp, unit: RegExp) => {
      const candidates: Array<{ value: string; confidence: number }> = [];
      for (let labelIndex = 0; labelIndex < text.length; labelIndex++) {
        if (!label.test(text[labelIndex].normalized)) continue;
        const nearby = text.slice(labelIndex, labelIndex + 4);
        for (const line of nearby) {
          const match = line.normalized.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unit.source}`));
          if (match) {
            candidates.push({ value: match[1].trim(), confidence: line.mean });
          }
        }
      }
      for (const line of text) {
        const match = line.normalized.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unit.source}`));
        if (match) candidates.push({ value: match[1].trim(), confidence: line.mean });
      }
      return candidates.sort((first, second) => second.confidence - first.confidence)[0];
    };
    const pressureAfter = (label: RegExp, unit: 'BAR' | 'PSI') => {
      const unitPattern = unit === 'BAR' ? /BAR\b/ : /PSI\b/;
      const candidates: Array<{ value: string; confidence: number }> = [];
      for (let labelIndex = 0; labelIndex < text.length; labelIndex++) {
        const labelMatch = text[labelIndex].normalized.match(label);
        if (!labelMatch || labelMatch.index === undefined) continue;
        const sameLine = text[labelIndex].normalized.slice(labelMatch.index + labelMatch[0].length);
        const nearby = [sameLine, ...text.slice(labelIndex + 1, labelIndex + 4).map((line) => line.normalized)];
        for (const source of nearby) {
          const match = source.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unitPattern.source}`));
          if (match) candidates.push({ value: match[1].trim(), confidence: text[labelIndex].mean });
        }
      }
      return candidates.sort((first, second) => second.confidence - first.confidence)[0];
    };
    const grossLabel = /\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR(?:[O0]SS)?\.?/;
    const mpgmKg = weightAfter(grossLabel, 'KG');
    const mpgmLb = weightAfter(grossLabel, 'LB');
    const tareKg = weightAfter(/\bTARE\b/, 'KG');
    const tareLb = weightAfter(/\bTARE\b/, 'LB');
    const payloadLabel = /\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)|\bNET(?:\s*WEIGHT)?\b/;
    const payloadKg = weightAfter(payloadLabel, 'KG');
    const payloadLb = weightAfter(payloadLabel, 'LB');
    const capacityLiters = capacityAfter(/\bCAP(?:ACITY|CITY)\b|\bCAPAC\.?\b/, /L\b/);
    const capacityUsGallons = capacityAfter(/\bCAP(?:ACITY|CITY)\b|\bCAPAC\.?\b/, /US\s*GAL\b/);
    const capacityCubicMeters = capacityAfter(/\bCU\.?\s*CAP\.?/, /CU\.?\s*M\.?/);
    const capacityCubicFeet = capacityAfter(/\bCU\.?\s*CAP\.?/, /CU\.?\s*FT\.?/);
    const maxWorkingPressureBar = pressureAfter(/MAX\s*WORKING\s*PRESSURE/, 'BAR');
    const maxWorkingPressurePsi = pressureAfter(/MAX\s*WORKING\s*PRESSURE/, 'PSI');
    fields.maxWorkingPressureBar = { value: maxWorkingPressureBar?.value ?? '', unit: 'BAR', confidence: maxWorkingPressureBar?.confidence };
    fields.maxWorkingPressurePsi = { value: maxWorkingPressurePsi?.value ?? '', unit: 'PSI', confidence: maxWorkingPressurePsi?.confidence };
    fields.mpgmKg = { value: mpgmKg?.value ?? '', unit: 'KG', confidence: mpgmKg?.confidence, inferred: mpgmKg?.inferred };
    fields.mpgmLb = { value: mpgmLb?.value ?? '', unit: 'LB', confidence: mpgmLb?.confidence, inferred: mpgmLb?.inferred };
    fields.tareKg = { value: tareKg?.value ?? '', unit: 'KG', confidence: tareKg?.confidence, inferred: tareKg?.inferred };
    fields.tareLb = { value: tareLb?.value ?? '', unit: 'LB', confidence: tareLb?.confidence, inferred: tareLb?.inferred };
    fields.payloadKg = payloadKg
      ? { value: payloadKg.value, unit: 'KG', confidence: payloadKg.confidence, inferred: payloadKg.inferred }
      : { value: '', unit: 'KG' };
    fields.payloadLb = payloadLb
      ? { value: payloadLb.value, unit: 'LB', confidence: payloadLb.confidence, inferred: payloadLb.inferred }
      : { value: '', unit: 'LB' };
    this.recoverMissingWeightRows(fields, text);
    fields.capacityLiters = { value: capacityLiters?.value ?? '', unit: 'L', confidence: capacityLiters?.confidence };
    fields.capacityUsGallons = { value: capacityUsGallons?.value ?? '', unit: 'US GAL', confidence: capacityUsGallons?.confidence };
    fields.capacityCubicMeters = { value: capacityCubicMeters?.value ?? '', unit: 'CU.M.', confidence: capacityCubicMeters?.confidence };
    fields.capacityCubicFeet = { value: capacityCubicFeet?.value ?? '', unit: 'CU.FT.', confidence: capacityCubicFeet?.confidence };
    return fields;
  }

  private recoverMissingWeightRows(fields: Record<FieldKey, ContainerField>, lines: Array<OcrLine & { normalized: string }>): void {
    const hasGrossLabel = lines.some((line) => /\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR\.?/.test(line.normalized));
    const hasTareLabel = lines.some((line) => /\bTARE\b/.test(line.normalized));
    const hasPayloadLabel = lines.some((line) => /\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)|\bNET(?:\s*WEIGHT)?\b/.test(line.normalized));
    // A complete pair of unlabeled rows after gross weight is the only safe layout
    // to recover. A single missing label could simply mean no such marking exists.
    if (!hasGrossLabel || hasTareLabel || hasPayloadLabel) {
      return;
    }
    const unlabeledRows = lines
      .filter((line) => !/\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR\.?|\bTARE\b|\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)|\bNET(?:\s*WEIGHT)?\b/.test(line.normalized))
      .map((line) => ({
        line,
        kg: line.normalized.match(/(\d[\d ,.]*)\s*KG/),
        lb: line.normalized.match(/(\d[\d ,.]*)\s*LB/),
        y: line.box ? line.box.reduce((total, [, y]) => total + y, 0) / line.box.length : Number.NaN,
      }))
      .filter((row) => row.kg || row.lb)
      .sort((first, second) => Number.isNaN(first.y) || Number.isNaN(second.y) ? 0 : first.y - second.y);
    const recover = (row: typeof unlabeledRows[number] | undefined, key: 'tareKg' | 'payloadKg', match: RegExpMatchArray | null) => {
      if (row && match && !fields[key].value) {
        fields[key] = { value: match[1].trim(), unit: 'KG', confidence: row.line.mean, inferred: true };
      }
    };
    recover(unlabeledRows[0], 'tareKg', unlabeledRows[0]?.kg ?? null);
    if (unlabeledRows[0]?.lb && !fields.tareLb.value) fields.tareLb = { value: unlabeledRows[0].lb[1].trim(), unit: 'LB', confidence: unlabeledRows[0].line.mean, inferred: true };
    const payloadRow = unlabeledRows[1];
    recover(payloadRow, 'payloadKg', payloadRow?.kg ?? null);
    if (payloadRow?.lb && !fields.payloadLb.value) fields.payloadLb = { value: payloadRow.lb[1].trim(), unit: 'LB', confidence: payloadRow.line.mean, inferred: true };
  }

  private formatContainerId(value: string): string {
    const normalized = value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return [normalized.slice(0, 4), normalized.slice(4, 10), normalized.slice(10, 11)]
      .filter(Boolean)
      .join(' ');
  }

  protected confidenceText(field: ContainerField): string {
    return field.confidence === undefined ? '' : `${Math.round(field.confidence * 100)}%`;
  }

  protected isLowConfidence(field: ContainerField): boolean {
    return field.confidence !== undefined && field.confidence < 0.85;
  }

  private validateContainerId(value: string): boolean {
    const normalized = value.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(normalized)) return false;
    const expectedCheckDigit = this.containerIdCheckDigit(normalized.slice(0, 10));
    return expectedCheckDigit !== null && expectedCheckDigit === normalized[10];
  }

  private containerIdCheckDigit(stem: string): string | null {
    const normalized = stem.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(normalized)) return null;
    const weights = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
    const letterValue = (letter: string) => {
      let value = letter.charCodeAt(0) - 55;
      // ISO 6346 skips 11, 22 and 33 in the letter value sequence.
      if (value >= 11) {
        value++;
      }
      if (value >= 22) {
        value++;
      }
      if (value >= 33) {
        value++;
      }
      return value;
    };
    const sum = normalized.slice(0, 10).split('').reduce((total, character, index) => {
      const value = /\d/.test(character) ? Number(character) : letterValue(character);
      return total + value * weights[index];
    }, 0);
    const checkDigit = (sum % 11) % 10;
    return String(checkDigit);
  }
}
