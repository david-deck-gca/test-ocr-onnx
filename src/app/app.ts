import { Component, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

type PayloadExportSource = 'detected' | 'calculated';
type FieldKey = 'containerId' | 'isoCode' | 'mpgmKg' | 'mpgmLb' | 'tareKg' | 'tareLb' | 'payloadKg' | 'payloadLb' | 'calculatedPayloadKg' | 'calculatedPayloadLb' | 'capacityLiters' | 'capacityCubicMeters' | 'capacityCubicFeet';
type OcrLine = { text: string; mean: number; box?: number[][] };
type CropRect = { x: number; y: number; width: number; height: number };
type BoxBounds = { left: number; top: number; right: number; bottom: number };
type CropResizeHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type OcrPass = { url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean; sourceWidth: number; sourceHeight: number };
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

interface StoredRecord {
  id: string;
  savedAt: string;
  containerId: string;
  fileName: string;
  payload: object;
  photo?: Blob;
}

interface SavedRecordPreview {
  id: string;
  savedAt: string;
  containerId: string;
  fileName: string;
  payload: object;
  photoUrl: string | null;
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
  protected readonly cropRect = signal<CropRect | null>(null);
  protected readonly cropDraft = signal<CropRect>(DEFAULT_CROP);
  protected readonly cropResizeHandles: CropResizeHandle[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  protected readonly cameraOpen = signal(false);
  protected readonly processing = signal(false);
  protected readonly status = signal('');
  protected readonly diagnostics = signal<Diagnostic[]>([]);
  protected readonly rawText = signal<string[]>([]);
  protected readonly savedRecords = signal<SavedRecordPreview[]>([]);
  protected readonly saving = signal(false);
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
  protected readonly payloadKgMismatch = computed(() => this.hasPayloadMismatch(
    this.fields().payloadKg.value,
    this.fields().calculatedPayloadKg.value,
  ));
  protected readonly payloadLbMismatch = computed(() => this.hasPayloadMismatch(
    this.fields().payloadLb.value,
    this.fields().calculatedPayloadLb.value,
  ));

  private stream: MediaStream | null = null;
  private readonly injector = inject(Injector);
  private ocr: Awaited<ReturnType<typeof Ocr.create>> | null = null;
  private cropStart: { x: number; y: number } | null = null;
  private cropResize: { handle: CropResizeHandle; crop: CropRect } | null = null;
  private imageSelection = 0;
  private readonly savedPhotoUrls = new Set<string>();

  constructor() {
    afterNextRender(() => void this.loadSavedRecords(), { injector: this.injector });
  }

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
    this.cropRect.set(crop);
    await this.processImage();
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
    this.status.set('Preparing local OCR models...');
    try {
      this.status.set('Loading local PaddleOCR models...');
      const ocr = await this.getOcr();
      this.status.set('Detecting painted text in the selected region...');
      const passes = await this.createOcrPasses(image);
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
      this.status.set(`OCR complete. Found ${lines.length} text region${lines.length === 1 ? '' : 's'}. Review the fields before exporting.`);
      this.processing.set(false);
    } catch (error: unknown) {
      this.processing.set(false);
      this.addDiagnostic('ONNX OCR', 'Local OCR could not process this image.', this.errorMessage(error));
    }
  }

  protected async saveJsonToIndexedDb(): Promise<void> {
    const photo = this.imageBlob();
    if (!photo) {
      this.addDiagnostic('Saved records', 'Choose or capture a photo before saving.');
      return;
    }
    this.saving.set(true);
    try {
      const database = await this.openSavedRecordsDatabase();
      const payload = this.createJsonPayload();
      const id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('records', 'readwrite');
        transaction.objectStore('records').add({
          id,
          savedAt: new Date().toISOString(),
          containerId: this.fields().containerId.value,
          fileName: this.sourceName(),
          payload,
          photo,
        } satisfies StoredRecord);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      await this.loadSavedRecords();
      this.status.set('Photo and JSON data saved locally in IndexedDB.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'The photo and JSON data could not be saved locally.', this.errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected async deleteSavedRecord(id: string): Promise<void> {
    try {
      const database = await this.openSavedRecordsDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('records', 'readwrite');
        transaction.objectStore('records').delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      await this.loadSavedRecords();
      this.status.set('Saved record deleted.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'The saved record could not be deleted.', this.errorMessage(error));
    }
  }

  protected savedRecordLabel(record: SavedRecordPreview): string {
    return record.containerId || record.fileName || 'Unnamed container';
  }

  protected savedAtLabel(savedAt: string): string {
    return new Date(savedAt).toLocaleString();
  }

  protected savedRecordJson(record: SavedRecordPreview): string {
    return JSON.stringify(record.payload, null, 2);
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
    this.releaseSavedPhotoUrls();
  }

  private useImage(image: Blob, name: string): void {
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    this.imageBlob.set(image);
    this.previewUrl.set(URL.createObjectURL(image));
    this.sourceName.set(name);
    this.cropRect.set(null);
    this.cropDraft.set(DEFAULT_CROP);
    this.rawText.set([]);
    const selection = ++this.imageSelection;
    void this.prepareInitialCrop(image, selection);
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

  private async prepareInitialCrop(image: Blob, selection: number): Promise<void> {
    this.processing.set(true);
    this.status.set('Locating the container ID and markings in the full photo...');
    try {
      const ocr = await this.getOcr();
      const pass = await this.createFullImagePass(image);
      let lines: OcrLine[];
      try {
        lines = this.deduplicateLines((await ocr.detect(pass.url)).map((line) => ({
          ...line,
          box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
        })));
      } finally {
        URL.revokeObjectURL(pass.url);
      }
      if (selection !== this.imageSelection || this.cropRect()) return;
      const fields = this.extractFields(lines);
      this.rawText.set(lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`));
      this.fields.set(fields);
      this.payloadExportSource.set(
        fields.calculatedPayloadKg.value || fields.calculatedPayloadLb.value ? 'calculated' : 'detected',
      );
      const containerId = fields.containerId.value;
      const suggestedCrop = this.createSuggestedCrop(lines, containerId, pass.sourceWidth, pass.sourceHeight);
      if (selection !== this.imageSelection || this.cropRect()) return;
      if (suggestedCrop) {
        this.cropDraft.set(suggestedCrop);
        this.status.set('');
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

  private async createOcrPasses(image: Blob): Promise<OcrPass[]> {
    const crop = this.cropRect();
    return [crop ? await this.createCropPass(image, crop, 1) : await this.createFullImagePass(image)];
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

  private createSuggestedCrop(lines: OcrLine[], containerId: string, imageWidth: number, imageHeight: number): CropRect | null {
    const markingsBounds = this.suggestedMarkingBounds(lines, containerId);
    if (!markingsBounds) return null;

    const padding = Math.max(24, Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top) * 0.08);
    const left = Math.max(0, markingsBounds.left - padding);
    const top = Math.max(0, markingsBounds.top - padding);
    const right = Math.min(imageWidth, markingsBounds.right + padding);
    const bottom = Math.min(imageHeight, markingsBounds.bottom + padding);
    return {
      x: left / imageWidth,
      y: top / imageHeight,
      width: (right - left) / imageWidth,
      height: (bottom - top) / imageHeight,
    };
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

  private async createCropPass(image: Blob, crop: CropRect, scale: number): Promise<OcrPass> {
    const bitmap = await createImageBitmap(image);
    try {
      const sourceX = Math.round(crop.x * bitmap.width);
      const sourceY = Math.round(crop.y * bitmap.height);
      const sourceWidth = Math.max(1, Math.round(crop.width * bitmap.width));
      const sourceHeight = Math.max(1, Math.round(crop.height * bitmap.height));
      const outputScale = scale;
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
      canvas.width = 0;
      canvas.height = 0;
      return { url: URL.createObjectURL(blob), offsetX: sourceX, offsetY: sourceY, scale: outputScale, revokeUrl: true, sourceWidth: bitmap.width, sourceHeight: bitmap.height };
    } finally {
      bitmap.close();
    }
  }

  private async createFullImagePass(image: Blob): Promise<OcrPass> {
    const bitmap = await createImageBitmap(image);
    try {
      return {
        url: URL.createObjectURL(image),
        offsetX: 0,
        offsetY: 0,
        scale: 1,
        revokeUrl: true,
        sourceWidth: bitmap.width,
        sourceHeight: bitmap.height,
      };
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
      const idPrefixLine = find(/[A-Z]{3}[UJZ][\s-]*\d{6}(?!\d)/);
      const idPrefix = idPrefixLine?.normalized.match(/[A-Z]{3}[UJZ][\s-]*\d{6}(?!\d)/)?.[0];
      const recoveredId = idPrefix ? this.completeContainerId(idPrefix) : null;
      if (!fields.containerId.value && recoveredId && idPrefixLine) {
        fields.containerId = { value: recoveredId, confidence: idPrefixLine.mean };
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
    const mpgmValue = this.weightNumber(mpgm.value);
    const tareValue = this.weightNumber(tare.value);
    if (!Number.isFinite(mpgmValue) || !Number.isFinite(tareValue) || mpgmValue < tareValue) {
      return { value: '', unit, calculated: true };
    }
    return { value: this.formatWeight(mpgmValue - tareValue), unit, calculated: true };
  }

  private async loadSavedRecords(): Promise<void> {
    if (!('indexedDB' in window)) {
      return;
    }
    try {
      const database = await this.openSavedRecordsDatabase();
      const records = await new Promise<StoredRecord[]>((resolve, reject) => {
        const transaction = database.transaction('records', 'readonly');
        const request = transaction.objectStore('records').getAll();
        request.onsuccess = () => resolve(request.result as StoredRecord[]);
        request.onerror = () => reject(request.error);
      });
      database.close();
      this.releaseSavedPhotoUrls();
      this.savedRecords.set(records
        .sort((first, second) => second.savedAt.localeCompare(first.savedAt))
        .map((record) => {
          const photoUrl = record.photo ? URL.createObjectURL(record.photo) : null;
          if (photoUrl) this.savedPhotoUrls.add(photoUrl);
          return {
            id: record.id,
            savedAt: record.savedAt,
            containerId: record.containerId,
            fileName: record.fileName,
            payload: record.payload,
            photoUrl,
          };
        }));
    } catch {
      // Saved-record history is optional; save operations report their own errors.
    }
  }

  private releaseSavedPhotoUrls(): void {
    this.savedPhotoUrls.forEach((url) => URL.revokeObjectURL(url));
    this.savedPhotoUrls.clear();
  }

  private hasPayloadMismatch(rawPayload: string, calculatedPayload: string): boolean {
    return Boolean(rawPayload && calculatedPayload && this.weightNumber(rawPayload) !== this.weightNumber(calculatedPayload));
  }

  private weightNumber(value: string): number {
    return Number(value.replace(/[ ,.]/g, ''));
  }

  private formatWeight(value: number): string {
    return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  private validateContainerId(value: string): boolean {
    const normalized = value.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(normalized)) {
      return false;
    }
    return normalized[10] === this.containerCheckDigit(normalized.slice(0, 10));
  }

  private completeContainerId(value: string): string | null {
    const normalized = value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return /^[A-Z]{3}[UJZ]\d{6}$/.test(normalized)
      ? `${normalized}${this.containerCheckDigit(normalized)}`
      : null;
  }

  private containerCheckDigit(prefix: string): string {
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
    const sum = prefix.split('').reduce((total, character, index) => {
      const value = /\d/.test(character) ? Number(character) : letterValue(character);
      return total + value * weights[index];
    }, 0);
    return String((sum % 11) % 10);
  }
}
