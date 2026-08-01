import { Component, ElementRef, computed, signal, viewChild } from '@angular/core';
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

type ProcessingMode = 'full-photo' | 'guided-crop';
type PayloadExportSource = 'detected' | 'calculated';
type FieldKey = 'containerId' | 'isoCode' | 'mpgmKg' | 'mpgmLb' | 'tareKg' | 'tareLb' | 'payloadKg' | 'payloadLb' | 'calculatedPayloadKg' | 'calculatedPayloadLb' | 'capacityLiters' | 'capacityCubicMeters' | 'capacityCubicFeet';
type OcrLine = { text: string; mean: number; box?: number[][] };
type CropRect = { x: number; y: number; width: number; height: number };
type BoxBounds = { left: number; top: number; right: number; bottom: number };
type CropResizeHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

interface ContainerField {
  value: string;
  unit?: string;
  confidence?: number;
  calculated?: boolean;
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
  protected readonly videoPreview = viewChild<ElementRef<HTMLVideoElement>>('videoPreview');
  protected readonly sourceName = signal('');
  protected readonly previewUrl = signal<string | null>(null);
  protected readonly imageBlob = signal<Blob | null>(null);
  protected readonly cropEditorOpen = signal(false);
  protected readonly cropRect = signal<CropRect | null>(null);
  protected readonly cropDraft = signal<CropRect>(DEFAULT_CROP);
  protected readonly cropPreviewUrl = signal<string | null>(null);
  protected readonly applyingCrop = signal(false);
  protected readonly automaticCropSuggested = signal(false);
  protected readonly cropResizeHandles: CropResizeHandle[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  protected readonly processingMode = signal<ProcessingMode>('full-photo');
  protected readonly cameraOpen = signal(false);
  protected readonly processing = signal(false);
  protected readonly status = signal('Choose a container image to begin.');
  protected readonly diagnostics = signal<Diagnostic[]>([]);
  protected readonly rawText = signal<string[]>([]);
  protected readonly fields = signal<Record<FieldKey, ContainerField>>({
    containerId: { value: '' },
    isoCode: { value: '' },
    mpgmKg: { value: '', unit: 'KG' },
    mpgmLb: { value: '', unit: 'LB' },
    tareKg: { value: '', unit: 'KG' },
    tareLb: { value: '', unit: 'LB' },
    payloadKg: { value: '', unit: 'KG' },
    payloadLb: { value: '', unit: 'LB' },
    calculatedPayloadKg: { value: '', unit: 'KG', calculated: true },
    calculatedPayloadLb: { value: '', unit: 'LB', calculated: true },
    capacityLiters: { value: '', unit: 'L' },
    capacityCubicMeters: { value: '', unit: 'CU.M.' },
    capacityCubicFeet: { value: '', unit: 'CU.FT.' },
  });
  protected readonly containerIdValid = computed(() => this.validateContainerId(this.fields().containerId.value));
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
  protected readonly payloadExportSource = signal<PayloadExportSource>('calculated');
  protected readonly canExportCalculatedPayload = computed(() => Boolean(
    this.fields().calculatedPayloadKg.value || this.fields().calculatedPayloadLb.value,
  ));

  private stream: MediaStream | null = null;
  private ocr: Awaited<ReturnType<typeof Ocr.create>> | null = null;
  private cropStart: { x: number; y: number } | null = null;
  private cropResize: { handle: CropResizeHandle; crop: CropRect } | null = null;
  private imageSelection = 0;

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

  protected openCropEditor(): void {
    this.cropDraft.set(this.cropRect() ?? DEFAULT_CROP);
    this.automaticCropSuggested.set(false);
    this.cropEditorOpen.set(true);
  }

  protected closeCropEditor(): void {
    this.cropStart = null;
    this.cropResize = null;
    this.cropEditorOpen.set(false);
  }

  protected startCrop(event: PointerEvent): void {
    const point = this.cropPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.cropStart = point;
    this.cropResize = null;
    this.cropDraft.set({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  protected startCropResize(event: PointerEvent, handle: CropResizeHandle): void {
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

  protected async applyCrop(): Promise<void> {
    const crop = this.cropDraft();
    if (crop.width < 0.02 || crop.height < 0.02) {
      this.addDiagnostic('Manual crop', 'Draw a larger rectangle around the marking to scan.');
      return;
    }
    this.applyingCrop.set(true);
    this.status.set('Preparing the selected crop...');
    try {
      await this.updateCropPreview(crop);
      this.cropRect.set(crop);
      this.automaticCropSuggested.set(false);
      this.cropEditorOpen.set(false);
      this.status.set('Manual crop ready. Run local OCR to scan only the selected region.');
    } catch (error: unknown) {
      this.addDiagnostic('Manual crop', 'The selected region could not be prepared. Adjust the rectangle or choose the image again.', this.errorMessage(error));
    } finally {
      this.applyingCrop.set(false);
    }
  }

  protected clearCrop(): void {
    this.cropRect.set(null);
    this.automaticCropSuggested.set(false);
    const preview = this.cropPreviewUrl();
    if (preview) URL.revokeObjectURL(preview);
    this.cropPreviewUrl.set(null);
    this.status.set('Manual crop removed. OCR will use the selected processing approach.');
  }

  protected async openCamera(): Promise<void> {
    this.clearFields();
    if (!navigator.mediaDevices?.getUserMedia) {
      this.addDiagnostic('Camera', 'This browser does not provide camera access.', 'navigator.mediaDevices.getUserMedia is unavailable.');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this.cameraOpen.set(true);
      queueMicrotask(() => {
        const video = this.videoPreview()?.nativeElement;
        if (video && this.stream) {
          video.srcObject = this.stream;
          void video.play();
        }
      });
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

  protected setMode(mode: ProcessingMode): void {
    this.processingMode.set(mode);
  }

  protected updateField(key: FieldKey, value: string): void {
    this.fields.update((fields) => {
      const updated = {
        ...fields,
        [key]: {
          ...fields[key],
          value,
          ...(key === 'payloadKg' || key === 'payloadLb' ? { calculated: false } : {}),
        },
      };
      return {
        ...updated,
        calculatedPayloadKg: this.calculatePayload(updated.payloadKg, updated.mpgmKg, updated.tareKg, 'KG'),
        calculatedPayloadLb: this.calculatePayload(updated.payloadLb, updated.mpgmLb, updated.tareLb, 'LB'),
      };
    });
  }

  protected setPayloadExportSource(source: PayloadExportSource): void {
    this.payloadExportSource.set(source);
  }

  protected async processImage(): Promise<void> {
    const image = this.imageBlob();
    if (!image) {
      this.addDiagnostic('Image input', 'Choose or capture a photo before starting OCR.');
      return;
    }
    this.processing.set(true);
    this.diagnostics.set([]);
    this.automaticCropSuggested.set(false);
    this.status.set('Preparing local OCR models...');
    const imageUrl = this.previewUrl();
    if (!imageUrl) {
      this.processing.set(false);
      this.addDiagnostic('Image input', 'The selected image preview is unavailable. Choose the image again.');
      return;
    }
    try {
      this.status.set('Loading local PaddleOCR models...');
      const ocr = await this.getOcr();
      this.status.set(this.processingMode() === 'guided-crop' ? 'Preparing enlarged marking crops...' : 'Detecting painted text regions...');
      const passes = await this.createOcrPasses(image, imageUrl);
      const lines = this.deduplicateLines((await Promise.all(passes.map(async (pass) => {
        try {
          const detected = await ocr.detect(pass.url);
          return detected.map((line) => ({
            ...line,
            box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
          }));
        } finally {
          if (pass.revokeUrl) {
            URL.revokeObjectURL(pass.url);
          }
        }
      }))).flat());
      const rawText = lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`);
      this.rawText.set(rawText);
      const fields = this.extractFields(lines);
      this.fields.set(fields);
      this.payloadExportSource.set(
        fields.calculatedPayloadKg.value || fields.calculatedPayloadLb.value ? 'calculated' : 'detected',
      );
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
        this.automaticCropSuggested.set(true);
        this.cropEditorOpen.set(true);
        this.status.set('OCR complete. Review the suggested region around the container ID and markings beneath it.');
      } else {
        this.status.set(`OCR complete. Found ${lines.length} text region${lines.length === 1 ? '' : 's'}. Review the fields before exporting.`);
      }
      this.processing.set(false);
    } catch (error: unknown) {
      this.processing.set(false);
      this.addDiagnostic('ONNX OCR', 'Local OCR could not process this image.', this.errorMessage(error));
    }
  }

  protected exportJson(): void {
    const payload = this.createJsonPayload();
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.sourceName().replace(/\.[^.]+$/, '') || 'container'}-ocr.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  protected async saveJsonToIndexedDb(): Promise<void> {
    try {
      const database = await this.openSavedRecordsDatabase();
      const payload = this.createJsonPayload();
      const id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('records', 'readwrite');
        transaction.objectStore('records').add({ id, savedAt: new Date().toISOString(), payload });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      this.status.set('JSON data saved locally in IndexedDB.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'JSON data could not be saved locally.', this.errorMessage(error));
    }
  }

  protected dismissDiagnostics(): void {
    this.diagnostics.set([]);
  }

  protected ngOnDestroy(): void {
    this.closeCamera();
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    const cropPreview = this.cropPreviewUrl();
    if (cropPreview) {
      URL.revokeObjectURL(cropPreview);
    }
  }

  private useImage(image: Blob, name: string): void {
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    this.imageBlob.set(image);
    this.previewUrl.set(URL.createObjectURL(image));
    this.sourceName.set(name);
    this.applyingCrop.set(false);
    this.automaticCropSuggested.set(false);
    this.cropEditorOpen.set(true);
    this.cropRect.set(null);
    this.cropDraft.set(DEFAULT_CROP);
    const cropPreview = this.cropPreviewUrl();
    if (cropPreview) URL.revokeObjectURL(cropPreview);
    this.cropPreviewUrl.set(null);
    this.rawText.set([]);
    const selection = ++this.imageSelection;
    void this.prepareInitialCrop(image, this.previewUrl()!, selection);
  }

  private clearFields(): void {
    this.fields.set({
      containerId: { value: '' },
      isoCode: { value: '' },
      mpgmKg: { value: '', unit: 'KG' },
      mpgmLb: { value: '', unit: 'LB' },
      tareKg: { value: '', unit: 'KG' },
      tareLb: { value: '', unit: 'LB' },
      payloadKg: { value: '', unit: 'KG' },
      payloadLb: { value: '', unit: 'LB' },
      calculatedPayloadKg: { value: '', unit: 'KG', calculated: true },
      calculatedPayloadLb: { value: '', unit: 'LB', calculated: true },
      capacityLiters: { value: '', unit: 'L' },
      capacityCubicMeters: { value: '', unit: 'CU.M.' },
      capacityCubicFeet: { value: '', unit: 'CU.FT.' },
    });
    this.rawText.set([]);
    this.payloadExportSource.set('calculated');
  }

  private async prepareInitialCrop(image: Blob, imageUrl: string, selection: number): Promise<void> {
    this.processing.set(true);
    this.status.set('Locating the container ID and markings in the full photo...');
    try {
      const ocr = await this.getOcr();
      const lines = this.deduplicateLines(await ocr.detect(imageUrl));
      const containerId = this.extractFields(lines).containerId.value;
      const suggestedCrop = await this.createSuggestedCrop(lines, containerId, image);
      if (selection !== this.imageSelection || this.cropRect()) return;
      if (suggestedCrop) {
        this.cropDraft.set(suggestedCrop);
        this.automaticCropSuggested.set(true);
        this.status.set('Container ID located. Review the suggested crop around it and the markings below.');
      } else {
        this.status.set('Container ID was not located. Draw a crop around the ID and markings you want to scan.');
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

  private async getOcr(): Promise<Awaited<ReturnType<typeof Ocr.create>>> {
    if (this.ocr) {
      return this.ocr;
    }
    ort.env.wasm.wasmPaths = new URL('ort/', document.baseURI).toString();
    ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    this.ocr = await Ocr.create({
      models: {
        detectionPath: new URL('models/ch_PP-OCRv4_det_infer.onnx', document.baseURI).toString(),
        recognitionPath: new URL('models/ch_PP-OCRv4_rec_infer.onnx', document.baseURI).toString(),
        dictionaryPath: new URL('models/ppocr_keys_v1.txt', document.baseURI).toString(),
      },
    });
    return this.ocr;
  }

  private addDiagnostic(stage: string, message: string, technical?: string): void {
    this.status.set(message);
    this.diagnostics.update((diagnostics) => [...diagnostics, { stage, message, technical }]);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async createOcrPasses(image: Blob, imageUrl: string): Promise<Array<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean }>> {
    const manualCrop = this.cropRect();
    if (manualCrop) {
      return [
        await this.createCropPass(image, manualCrop, 1),
        await this.createCropPass(image, manualCrop, 2),
      ];
    }
    if (this.processingMode() === 'full-photo') {
      return [{ url: imageUrl, offsetX: 0, offsetY: 0, scale: 1, revokeUrl: false }];
    }

    const bitmap = await createImageBitmap(image);
    try {
      const overlap = 0.12;
      const passes = [
        { x: 0, y: 0, width: 0.5 + overlap, height: 0.5 + overlap },
        { x: 0.5 - overlap, y: 0, width: 0.5 + overlap, height: 0.5 + overlap },
        { x: 0, y: 0.5 - overlap, width: 0.5 + overlap, height: 0.5 + overlap },
        { x: 0.5 - overlap, y: 0.5 - overlap, width: 0.5 + overlap, height: 0.5 + overlap },
      ];
      const enhancedPasses = await Promise.all(passes.map(async (pass) => {
        const sourceX = Math.round(pass.x * bitmap.width);
        const sourceY = Math.round(pass.y * bitmap.height);
        const sourceWidth = Math.min(bitmap.width - sourceX, Math.round(pass.width * bitmap.width));
        const sourceHeight = Math.min(bitmap.height - sourceY, Math.round(pass.height * bitmap.height));
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = sourceWidth * scale;
        canvas.height = sourceHeight * scale;
        const context = canvas.getContext('2d');
        if (!context) {
          throw new Error('Canvas 2D context is unavailable.');
        }
        context.filter = 'contrast(145%) grayscale(100%)';
        context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
        const crop = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Guided crop could not be created.'));
        }, 'image/png'));
        return { url: URL.createObjectURL(crop), offsetX: sourceX, offsetY: sourceY, scale, revokeUrl: true };
      }));
      // Keep the native photo because rasterized crops can lose a small ISO check digit.
      return [{ url: imageUrl, offsetX: 0, offsetY: 0, scale: 1, revokeUrl: false }, ...enhancedPasses];
    } finally {
      bitmap.close();
    }
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

  private async updateCropPreview(crop: CropRect): Promise<void> {
    const image = this.imageBlob();
    if (!image) return;
    const pass = await this.createCropPass(image, crop, 1, 520);
    const previous = this.cropPreviewUrl();
    this.cropPreviewUrl.set(pass.url);
    if (previous) URL.revokeObjectURL(previous);
  }

  private async createSuggestedCrop(lines: OcrLine[], containerId: string, image: Blob): Promise<CropRect | null> {
    const markingsBounds = this.suggestedMarkingBounds(lines, containerId);
    if (!markingsBounds) return null;

    const bitmap = await createImageBitmap(image);
    try {
      const padding = Math.max(24, Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top) * 0.08);
      const left = Math.max(0, markingsBounds.left - padding);
      const top = Math.max(0, markingsBounds.top - padding);
      const right = Math.min(bitmap.width, markingsBounds.right + padding);
      const bottom = Math.min(bitmap.height, markingsBounds.bottom + padding);
      return {
        x: left / bitmap.width,
        y: top / bitmap.height,
        width: (right - left) / bitmap.width,
        height: (bottom - top) / bitmap.height,
      };
    } finally {
      bitmap.close();
    }
  }

  private suggestedMarkingBounds(lines: OcrLine[], containerId: string): BoxBounds | null {
    if (!containerId) return null;
    const idLines = this.linesForContainerId(lines, containerId);
    const idBounds = this.combineBounds(idLines.map((line) => this.boxBounds(line.box)).filter((bounds): bounds is BoxBounds => Boolean(bounds)));
    if (!idBounds) return null;

    const idWidth = idBounds.right - idBounds.left;
    const idHeight = idBounds.bottom - idBounds.top;
    const horizontalAllowance = Math.max(idWidth * 1.5, idHeight * 8);
    const relevantBounds = lines
      .map((line) => this.boxBounds(line.box))
      .filter((bounds): bounds is BoxBounds => Boolean(bounds))
      .filter((bounds) => bounds.bottom >= idBounds.top - idHeight
        && bounds.right >= idBounds.left - horizontalAllowance
        && bounds.left <= idBounds.right + horizontalAllowance);
    return this.combineBounds([idBounds, ...relevantBounds]);
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
        if (candidate.map((fragment) => fragment.text).join('').includes(normalizedId)) {
          return candidate.map((fragment) => fragment.line);
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

  private async createCropPass(image: Blob, crop: CropRect, scale: number, maximumWidth?: number): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean }> {
    const bitmap = await createImageBitmap(image);
    try {
      const sourceX = Math.round(crop.x * bitmap.width);
      const sourceY = Math.round(crop.y * bitmap.height);
      const sourceWidth = Math.max(1, Math.round(crop.width * bitmap.width));
      const sourceHeight = Math.max(1, Math.round(crop.height * bitmap.height));
      const outputScale = maximumWidth ? Math.min(1, maximumWidth / sourceWidth) : scale;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * outputScale));
      canvas.height = Math.max(1, Math.round(sourceHeight * outputScale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas 2D context is unavailable.');
      context.drawImage(bitmap, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('Manual crop could not be created.'));
      }, 'image/png'));
      return { url: URL.createObjectURL(blob), offsetX: sourceX, offsetY: sourceY, scale: outputScale, revokeUrl: true };
    } finally {
      bitmap.close();
    }
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
    const payloadSource = this.payloadExportSource();
    const payloadKg = payloadSource === 'calculated' ? fields.calculatedPayloadKg : fields.payloadKg;
    const payloadLb = payloadSource === 'calculated' ? fields.calculatedPayloadLb : fields.payloadLb;
    const warnings = this.diagnostics().map((diagnostic) => `${diagnostic.stage}: ${diagnostic.message}`);
    if (fields.containerId.value && !this.containerIdValid()) {
      warnings.push('Container ID does not pass ISO 6346 format and check-digit validation.');
    }
    return {
      source: {
        fileName: this.sourceName(),
        processedAt: new Date().toISOString(),
        processingMode: this.processingMode(),
        manualCrop: this.cropRect(),
      },
      container: {
        id: { ...fields.containerId, iso6346Valid: this.containerIdValid() },
        isoCode: fields.isoCode,
        mpgm: { kg: fields.mpgmKg, lb: fields.mpgmLb },
        tare: { kg: fields.tareKg, lb: fields.tareLb },
        payload: { source: payloadSource, kg: payloadKg, lb: payloadLb },
        capacity: {
          liters: fields.capacityLiters,
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
      const request = indexedDB.open('container-mark-reader', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('records')) {
          request.result.createObjectStore('records', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private extractFields(lines: OcrLine[]): Record<FieldKey, ContainerField> {
    const fields: Record<FieldKey, ContainerField> = {
      containerId: { value: '' }, isoCode: { value: '' },
      mpgmKg: { value: '', unit: 'KG' }, mpgmLb: { value: '', unit: 'LB' },
      tareKg: { value: '', unit: 'KG' }, tareLb: { value: '', unit: 'LB' },
      payloadKg: { value: '', unit: 'KG' }, payloadLb: { value: '', unit: 'LB' },
      calculatedPayloadKg: { value: '', unit: 'KG', calculated: true },
      calculatedPayloadLb: { value: '', unit: 'LB', calculated: true },
      capacityLiters: { value: '', unit: 'L' },
      capacityCubicMeters: { value: '', unit: 'CU.M.' },
      capacityCubicFeet: { value: '', unit: 'CU.FT.' },
    };
    const text = lines.map((line) => ({ ...line, normalized: line.text.toUpperCase().replace(/[|]/g, 'I') }));
    const find = (pattern: RegExp) => text.find((line) => pattern.test(line.normalized));
    const idLine = find(/[A-Z]{3}[UJZ][\s-]*\d{6}[\s-]*\d/);
    if (idLine) {
      fields.containerId = { value: idLine.normalized.match(/[A-Z]{3}[UJZ][\s-]*\d{6}[\s-]*\d/)![0].replace(/[\s-]/g, ''), confidence: idLine.mean };
    } else {
      const idFragments = text
        .map((line, index) => ({
          ...line,
          index,
          fragment: line.normalized.replace(/[^A-Z0-9]/g, ''),
          center: line.box?.reduce(([totalX, totalY], [x, y]) => [totalX + x, totalY + y], [0, 0]).map((total) => total / line.box!.length),
        }))
        .filter((line) => line.fragment)
        .sort((first, second) => {
          if (!first.center || !second.center) return first.index - second.index;
          return first.center[1] - second.center[1] || first.center[0] - second.center[0];
        });
      for (let start = 0; start < idFragments.length && !fields.containerId.value; start++) {
        for (let length = 2; length <= 3 && start + length <= idFragments.length; length++) {
          const candidate = idFragments.slice(start, start + length).map((line) => line.fragment).join('');
          const recovered = candidate.match(/[A-Z]{3}[UJZ]\d{7}/)?.[0];
          if (recovered && this.validateContainerId(recovered)) {
            fields.containerId = {
              value: recovered,
              confidence: Math.min(...idFragments.slice(start, start + length).map((line) => line.mean)),
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
      const numberText = (value: string) => value.trim();
      const labeledWeight = text
        .map((line) => {
          const labelMatch = line.normalized.match(label);
          const valueText = labelMatch?.index === undefined
            ? undefined
            : line.normalized.slice(labelMatch.index + labelMatch[0].length);
          return { line, match: valueText?.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unit}`)) };
        })
        .filter(({ match }) => match)
        .sort((first, second) => second.line.mean - first.line.mean)[0];
      if (labeledWeight?.match) {
        return { value: numberText(labeledWeight.match[1]), confidence: labeledWeight.line.mean };
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
          .map((line) => ({ line, match: line.normalized.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unit}`)), center: center(line) }))
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
          return { value: numberText(closestWeight.match[1]), confidence: closestWeight.line.mean };
        }
      }
      const nearby = text.slice(labelIndex);
      for (const line of nearby) {
        const match = line.normalized.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unit}`));
        if (match) {
          return { value: numberText(match[1]), confidence: line.mean };
        }
      }
      return undefined;
    };
    const capacityAfter = (label: RegExp, unit: RegExp) => {
      const labelIndex = text.findIndex((line) => label.test(line.normalized));
      if (labelIndex < 0) return undefined;
      const nearby = text.slice(labelIndex, labelIndex + 4);
      for (const line of nearby) {
        const match = line.normalized.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unit.source}`));
        if (match) {
          return { value: match[1].trim(), confidence: line.mean };
        }
      }
      return undefined;
    };
    const mpgmKg = weightAfter(/\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR\.?/, 'KG');
    const mpgmLb = weightAfter(/\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR\.?/, 'LB');
    const tareKg = weightAfter(/\bTARE\b/, 'KG');
    const tareLb = weightAfter(/\bTARE\b/, 'LB');
    const payloadLabel = /\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)|\bNET(?:\s*WEIGHT)?\b/;
    const payloadKg = weightAfter(payloadLabel, 'KG');
    const payloadLb = weightAfter(payloadLabel, 'LB');
    const capacityLiters = capacityAfter(/\bCAP(?:ACITY|CITY)\b|\bCAPAC\.?\b/, /L\b/);
    const capacityCubicMeters = capacityAfter(/\bCU\.?\s*CAP\.?/, /CU\.?\s*M\.?/);
    const capacityCubicFeet = capacityAfter(/\bCU\.?\s*CAP\.?/, /CU\.?\s*FT\.?/);
    fields.mpgmKg = { value: mpgmKg?.value ?? '', unit: 'KG', confidence: mpgmKg?.confidence };
    fields.mpgmLb = { value: mpgmLb?.value ?? '', unit: 'LB', confidence: mpgmLb?.confidence };
    fields.tareKg = { value: tareKg?.value ?? '', unit: 'KG', confidence: tareKg?.confidence };
    fields.tareLb = { value: tareLb?.value ?? '', unit: 'LB', confidence: tareLb?.confidence };
    fields.payloadKg = payloadKg
      ? { value: payloadKg.value, unit: 'KG', confidence: payloadKg.confidence, calculated: false }
      : { value: '', unit: 'KG' };
    fields.payloadLb = payloadLb
      ? { value: payloadLb.value, unit: 'LB', confidence: payloadLb.confidence, calculated: false }
      : { value: '', unit: 'LB' };
    this.recoverMissingWeightRows(fields, text);
    fields.calculatedPayloadKg = this.calculatePayload(fields.payloadKg, fields.mpgmKg, fields.tareKg, 'KG');
    fields.calculatedPayloadLb = this.calculatePayload(fields.payloadLb, fields.mpgmLb, fields.tareLb, 'LB');
    fields.capacityLiters = { value: capacityLiters?.value ?? '', unit: 'L', confidence: capacityLiters?.confidence };
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
        fields[key] = { value: match[1].trim(), unit: 'KG', confidence: row.line.mean, inferred: true, calculated: false };
      }
    };
    recover(unlabeledRows[0], 'tareKg', unlabeledRows[0]?.kg ?? null);
    if (unlabeledRows[0]?.lb && !fields.tareLb.value) fields.tareLb = { value: unlabeledRows[0].lb[1].trim(), unit: 'LB', confidence: unlabeledRows[0].line.mean, inferred: true };
    const payloadRow = unlabeledRows[1];
    recover(payloadRow, 'payloadKg', payloadRow?.kg ?? null);
    if (payloadRow?.lb && !fields.payloadLb.value) fields.payloadLb = { value: payloadRow.lb[1].trim(), unit: 'LB', confidence: payloadRow.line.mean, inferred: true, calculated: false };
  }

  private calculatePayload(payload: ContainerField, mpgm: ContainerField, tare: ContainerField, unit: 'KG' | 'LB'): ContainerField {
    if (!payload.value || !mpgm.value || !tare.value) {
      return { value: '', unit, calculated: true };
    }
    const parseWeight = (value: string) => Number(value.replace(/[ ,.]/g, ''));
    const mpgmValue = parseWeight(mpgm.value);
    const tareValue = parseWeight(tare.value);
    if (!Number.isFinite(mpgmValue) || !Number.isFinite(tareValue) || mpgmValue < tareValue) {
      return { value: '', unit, calculated: true };
    }
    return { value: String(mpgmValue - tareValue), unit, calculated: true };
  }

  private validateContainerId(value: string): boolean {
    const normalized = value.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(normalized)) {
      return false;
    }
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
    return checkDigit === Number(normalized[10]);
  }
}
