import { Component, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { ExecutionProvider, OcrService, ProviderCapability } from './ocr.service';

type CaptureMode = 'auto-crop' | 'manual-crop';
type DataPlateScale = 'original' | 'divide-2' | 'divide-3' | 'divide-4' | 'zoom-2' | 'zoom-3' | 'zoom-4' | 'zoom-5' | 'zoom-10' | 'zoom-20';
type FieldKey = 'maxWorkingPressureBar' | 'maxWorkingPressurePsi' | 'containerId' | 'isoCode' | 'approvalCode' | 'applicableRegulations' | 'tankCode' | 'kemlerCode' | 'unNumber' | 'mpgmKg' | 'mpgmLb' | 'tareKg' | 'tareLb' | 'payloadKg' | 'payloadLb' | 'capacityLiters' | 'capacityUsGallons' | 'capacityCubicMeters' | 'capacityCubicFeet';
type OcrLine = { text: string; mean: number; box?: number[][] };
type UnwarpGeometry = { rotation: number; curvature: number; reliable: boolean };
type CropRect = { x: number; y: number; width: number; height: number };
type BoxBounds = { left: number; top: number; right: number; bottom: number };
type CropResizeHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type DecodedImage = { source: CanvasImageSource; width: number; height: number; release: () => void };
type RawScan = { label: string; lines: Array<{ text: string; confidence: number }>; durationMs: number; pixelCount: number };
type DataPlatePreprocess = 'original' | 'contrast' | 'invert-contrast' | 'clahe-dark' | 'clahe-light' | 'blackhat' | 'illumination' | 'unsharp' | 'closing' | 'adaptive-dark' | 'adaptive-light';
type RepairTool = 'freehand' | 'line';
type RepairColor = 'dark' | 'light';
type RepairPoint = { x: number; y: number };
type RepairStroke = { tool: RepairTool; color: RepairColor; width: number; points: RepairPoint[] };
type OpenCvMat = { data: Uint8Array; rows: number; cols: number; delete: () => void };
type OpenCvClahe = { apply: (source: OpenCvMat, destination: OpenCvMat) => void; delete: () => void };
type OpenCvApi = {
  COLOR_RGBA2GRAY: number;
  Mat: new () => OpenCvMat;
  Size: new (width: number, height: number) => unknown;
  CLAHE?: new (clipLimit: number, tileGridSize: unknown) => OpenCvClahe;
  matFromImageData: (image: ImageData) => OpenCvMat;
  cvtColor: (source: OpenCvMat, destination: OpenCvMat, code: number) => void;
  createCLAHE?: (clipLimit: number, tileGridSize: unknown) => OpenCvClahe;
};
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
  protected readonly repairCanvas = viewChild<ElementRef<HTMLCanvasElement>>('repairCanvas');
  protected readonly videoPreview = viewChild<ElementRef<HTMLVideoElement>>('videoPreview');
  protected readonly sourceName = signal('');
  protected readonly previewUrl = signal<string | null>(null);
  protected readonly unwarpedCropUrl = signal<string | null>(null);
  protected readonly checkDigitPreviewUrl = signal<string | null>(null);
  protected readonly imageBlob = signal<Blob | null>(null);
  protected readonly cropRect = signal<CropRect | null>(null);
  protected readonly cropDraft = signal<CropRect>(DEFAULT_CROP);
  protected readonly applyingCrop = signal(false);
  protected readonly repairOpen = signal(false);
  protected readonly repairTool = signal<RepairTool>('freehand');
  protected readonly repairColor = signal<RepairColor>('dark');
  protected readonly repairWidth = signal(3);
  protected readonly repairStrokes = signal<RepairStroke[]>([]);
  protected readonly cropResizeHandles: CropResizeHandle[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  protected readonly captureMode = signal<CaptureMode>(defaultCaptureMode());
  protected readonly dataPlateScale = signal<DataPlateScale | null>(null);
  protected readonly manualCropDrawn = signal(false);
  protected readonly unwarpSelectedRegion = signal(false);
  protected readonly unwarpRotation = signal(0);
  protected readonly cameraOpen = signal(false);
  protected readonly processing = signal(false);
  protected readonly analysisSuccessful = signal(false);
  protected readonly status = signal('Choose a container image to begin.');
  protected readonly diagnostics = signal<Diagnostic[]>([]);
  protected readonly rawText = signal<string[]>([]);
  protected readonly rawScans = signal<RawScan[]>([]);
  protected readonly rawScansCollapsed = signal(false);
  protected readonly selectedProvider = signal<ExecutionProvider>('wasm');
  protected readonly providerCapabilities = signal<ProviderCapability[]>([{ provider: 'wasm', available: true }]);
  private readonly selectedOcrLines = signal<OcrLine[]>([]);
  protected readonly savedRecords = signal<SavedRecord[]>([]);
  protected readonly savedJson = signal<string | null>(null);
  protected readonly savedPhoto = signal<{ id: string; name: string; url: string } | null>(null);
  protected readonly fields = signal<Record<FieldKey, ContainerField>>({
    maxWorkingPressureBar: { value: '', unit: 'BAR' },
    maxWorkingPressurePsi: { value: '', unit: 'PSI' },
    containerId: { value: '' },
    isoCode: { value: '' },
    approvalCode: { value: '' },
    applicableRegulations: { value: '' },
    tankCode: { value: '' },
    kemlerCode: { value: '' },
    unNumber: { value: '' },
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
  protected readonly formattedContainerIdStem = computed(() => this.formatContainerId(this.fields().containerId.value.slice(0, 10)));
  protected readonly inferredContainerIdDigit = computed(() => this.fields().containerId.value.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(10, 11));
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
    const text = this.rawText().join('\n').toUpperCase();
    const unTankGross = /\bUN\s*TANK\b/.test(text) && Boolean(this.fields().mpgmKg.value);
    return {
       gross: unTankGross || markings.maxGr ? 'MAX.GR.' : markings.mpgm ? 'MPGM' : markings.mgw ? 'MGW' : '',
      payload: markings.payload ? 'PAYLOAD' : markings.net || this.fields().payloadKg.value ? 'NET' : '',
    };
  });

  private stream: MediaStream | null = null;
  private readonly injector = inject(Injector);
  private readonly ocrService = inject(OcrService);
  private cropStart: { x: number; y: number } | null = null;
  private cropResize: { handle: CropResizeHandle; crop: CropRect } | null = null;
  private repairDraft: RepairStroke | null = null;
  private repairRedoStack: RepairStroke[] = [];
  private imageSelection = 0;
  private previewRetries = 0;
  private previewLoad: { selection: number; resolve: (image: HTMLImageElement) => void; reject: (reason: Error) => void } | null = null;
  private lastAutoCropPixelCount = 0;
  private lastCropPassPixelCount = 0;

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
    const imageExtension = /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
    if (!file.type.startsWith('image/') && !imageExtension) {
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
    if (this.cropDraft().width >= 0.02 && this.cropDraft().height >= 0.02) {
      this.manualCropDrawn.set(true);
    }
  }

  protected openRepairEditor(): void {
    if (this.processing() || this.applyingCrop()) return;
    const crop = this.cropDraft();
    if (crop.width < 0.02 || crop.height < 0.02) {
      this.addDiagnostic('Manual repair', 'Draw a crop before opening the repair editor.');
      return;
    }
    this.cropRect.set(crop);
    this.repairOpen.set(true);
    afterNextRender(() => this.renderRepairCanvas(), { injector: this.injector });
  }

  protected closeRepairEditor(): void {
    this.repairOpen.set(false);
    this.repairDraft = null;
  }

  protected repairImageLoaded(): void {
    this.renderRepairCanvas();
  }

  protected setRepairTool(tool: string): void {
    if (tool === 'freehand' || tool === 'line') this.repairTool.set(tool);
  }

  protected setRepairColor(color: string): void {
    if (color === 'dark' || color === 'light') this.repairColor.set(color);
  }

  protected setRepairWidth(width: number): void {
    if (Number.isFinite(width)) this.repairWidth.set(Math.max(1, Math.min(20, width)));
  }

  protected startRepair(event: PointerEvent): void {
    if (this.processing() || this.applyingCrop()) return;
    const point = this.repairPoint(event);
    if (!point) return;
    event.preventDefault();
    const canvas = event.currentTarget as HTMLCanvasElement;
    canvas.setPointerCapture(event.pointerId);
    this.repairDraft = { tool: this.repairTool(), color: this.repairColor(), width: this.repairWidth(), points: [point] };
    this.renderRepairCanvas();
  }

  protected updateRepair(event: PointerEvent): void {
    if (!this.repairDraft) return;
    const point = this.repairPoint(event);
    if (!point) return;
    if (this.repairDraft.tool === 'line') {
      this.repairDraft = { ...this.repairDraft, points: [this.repairDraft.points[0], point] };
    } else {
      this.repairDraft = { ...this.repairDraft, points: [...this.repairDraft.points, point] };
    }
    this.renderRepairCanvas();
  }

  protected finishRepair(event: PointerEvent): void {
    if (!this.repairDraft) return;
    this.updateRepair(event);
    const canvas = event.currentTarget as HTMLCanvasElement;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const stroke = this.repairDraft;
    this.repairDraft = null;
    if (stroke.points.length > 1 || stroke.tool === 'line') {
      this.repairStrokes.update((strokes) => [...strokes, stroke]);
      this.repairRedoStack = [];
    }
    this.renderRepairCanvas();
  }

  protected undoRepair(): void {
    this.repairStrokes.update((strokes) => {
      if (!strokes.length) return strokes;
      const next = [...strokes];
      const removed = next.pop();
      if (removed) this.repairRedoStack.push(removed);
      return next;
    });
    this.renderRepairCanvas();
  }

  protected redoRepair(): void {
    const stroke = this.repairRedoStack.pop();
    if (!stroke) return;
    this.repairStrokes.update((strokes) => [...strokes, stroke]);
    this.renderRepairCanvas();
  }

  protected clearRepair(): void {
    this.repairStrokes.set([]);
    this.repairRedoStack = [];
    this.renderRepairCanvas();
  }

  private repairPoint(event: PointerEvent): RepairPoint | null {
    const canvas = event.currentTarget as HTMLCanvasElement;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  private renderRepairCanvas(): void {
    const canvas = this.repairCanvas()?.nativeElement;
    const image = this.previewImage()?.nativeElement;
    if (!canvas || !image?.naturalWidth || !image.naturalHeight) return;
    if (canvas.width !== image.naturalWidth || canvas.height !== image.naturalHeight) {
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of [...this.repairStrokes(), ...(this.repairDraft ? [this.repairDraft] : [])]) {
      this.drawRepairStroke(context, stroke, canvas.width, canvas.height, 1);
    }
  }

  private drawRepairStroke(context: CanvasRenderingContext2D, stroke: RepairStroke, width: number, height: number, scale: number): void {
    if (stroke.points.length < 1) return;
    context.save();
    context.beginPath();
    context.strokeStyle = stroke.color === 'dark' ? '#111' : '#fff';
    context.lineWidth = stroke.width * scale;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
    for (const point of stroke.points.slice(1)) context.lineTo(point.x * width, point.y * height);
    context.stroke();
    context.restore();
  }

  protected async applyCropAndProcess(): Promise<void> {
    const crop = this.cropDraft();
    if ((this.dataPlateScale() || this.captureMode() === 'manual-crop') && !this.manualCropDrawn()) {
      this.addDiagnostic('Manual crop', 'Draw a crop around the marking to scan.');
      return;
    }
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
    this.manualCropDrawn.set(false);
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

  protected setDataPlateScale(value: string): void {
    if (this.processing() || this.applyingCrop()) return;
    const validScales: DataPlateScale[] = ['original', 'divide-2', 'divide-3', 'divide-4', 'zoom-2', 'zoom-3', 'zoom-4', 'zoom-5', 'zoom-10', 'zoom-20'];
    if (!validScales.includes(value as DataPlateScale)) {
      this.dataPlateScale.set(null);
      return;
    }
    this.dataPlateScale.set(value as DataPlateScale);
    this.captureMode.set('manual-crop');
    this.manualCropDrawn.set(false);
    this.cropRect.set(null);
    this.cropDraft.set(DEFAULT_CROP);
    this.closeRepairEditor();
    this.repairStrokes.set([]);
    this.repairRedoStack = [];
    this.manualCropDrawn.set(false);
    this.clearFields();
    this.clearUnwarpedCropPreview();
    this.status.set('Draw a crop around the data plate, then scan the selected crop region.');
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
      this.rawScansCollapsed.set(false);
      const crop = this.cropRect();
      const scale = this.dataPlateScale();
      let lines: OcrLine[];
      if (scale) {
        if (!crop) throw new Error('Draw a crop before scanning the Data plate.');
        lines = await this.scanDataPlateCrop(image, crop, scale, recovery);
      } else {
        const scanResults = await this.scanOcrPasses(image, recovery);
        lines = this.selectBestOcrLines(scanResults);
      }
      this.selectedOcrLines.set(lines);
      const rawText = lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`);
      this.rawText.set(rawText);
      const fields = this.extractFields(lines);
      this.fields.set(fields);
      if (scale) {
        await this.runLowConfidenceFieldScans(image, lines, fields);
      } else if (crop && fields.containerId.value && !this.containerIdValid()) {
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

  protected setExecutionProvider(provider: string): void {
    if (provider === 'wasm' || provider === 'webgl' || provider === 'webgpu') {
      this.selectedProvider.set(provider);
    }
  }

  /* Benchmark-only provider and pipeline code removed from the application.
  protected async benchmarkProviders(): Promise<void> {
    const image = this.imageBlob();
    if (!image) {
      this.addDiagnostic('Provider benchmark', 'Choose an image before benchmarking execution providers.');
      return;
    }
    const preview = this.previewImage()?.nativeElement;
    if (!preview?.naturalWidth || !preview.naturalHeight) {
      this.addDiagnostic('Provider benchmark', 'Wait for the image preview to finish loading before benchmarking.');
      return;
    }

    this.processing.set(true);
    this.benchmarkResults.set([]);
    this.status.set('Preparing one identical crop for every execution provider...');
    const crop = this.cropRect() ?? DEFAULT_CROP;
    const maximumPixels = this.cropRect() ? MAX_MANUAL_CROP_PIXELS : MAX_FULL_PHOTO_PIXELS;
    let pass: { url: string; revokeUrl: boolean; pixelCount: number };
    try {
      pass = await this.createCropPass(image, crop, 1, undefined, maximumPixels);
    } catch (error: unknown) {
      this.processing.set(false);
      this.addDiagnostic('Provider benchmark', 'The image could not be prepared for benchmarking.', this.errorMessage(error));
      return;
    }
    try {
      const results: BenchmarkResult[] = [];
      for (const capability of this.providerCapabilities()) {
        if (!capability.available) {
          results.push({ provider: capability.provider, available: false, error: capability.reason });
          continue;
        }
        this.status.set(`Benchmarking ${this.providerLabel(capability.provider)}...`);
        const initializationStartedAt = performance.now();
        try {
          await this.ocrService.initialize(capability.provider);
          const initializationMs = Math.round(performance.now() - initializationStartedAt);
          const coldStartedAt = performance.now();
          const coldLines = await this.detectWithTimeout(pass.url, capability.provider);
          const coldOcrMs = Math.round(performance.now() - coldStartedAt);
          const warmStartedAt = performance.now();
          const warmLines = await this.detectWithTimeout(pass.url, capability.provider);
          const warmOcrMs = Math.round(performance.now() - warmStartedAt);
          results.push({ provider: capability.provider, available: true, initializationMs, coldOcrMs, warmOcrMs, lineCount: warmLines.length });
          if (!coldLines.length && warmLines.length) {
            this.addDiagnostic('Provider benchmark', `${this.providerLabel(capability.provider)} returned text only after its warm-up run.`);
          }
        } catch (error: unknown) {
          results.push({ provider: capability.provider, available: true, error: this.errorMessage(error) });
        }
        this.benchmarkResults.set([...results]);
      }
      this.status.set('Provider benchmark complete. Compare cold and warm OCR timings below.');
    } finally {
      if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
      this.processing.set(false);
    }
  }

  private async runReducedFieldBenchmark(baseline: Record<string, BenchmarkField>): Promise<ExperimentalBenchmarkResult> {
    const image = this.imageBlob();
    if (!image) throw new Error('Benchmark image is not loaded.');
    const startedAt = performance.now();
    const scans: RawScan[] = [];
    const reduced = await this.createBenchmarkScan(image, DEFAULT_CROP, 0.5, MAX_AUTO_CROP_FALLBACK_PIXELS, 'Reduced full photo');
    scans.push(reduced.scan);
    let fields = this.extractFields(reduced.lines);
    const firstScanFields = { ...fields };
    const rescannedKeys = new Set<string>();

    for (const key of Object.keys(baseline) as FieldKey[]) {
      const target = baseline[key];
      if (!target?.value) continue;
      const candidate = fields[key];
      if (candidate?.value && (candidate.confidence ?? 0) >= (target.confidence ?? 0)
        && this.benchmarkValue(candidate.value) === this.benchmarkValue(target.value)) continue;

      const line = this.benchmarkLineForField(reduced.lines, candidate?.value, target.value);
      const bounds = line ? this.boxBounds(line.box) : null;
      if (!bounds) continue;
      const crop = this.benchmarkLineCrop(bounds, this.previewImage()?.nativeElement.naturalWidth ?? 1, this.previewImage()?.nativeElement.naturalHeight ?? 1);
      const valueBounds = line ? this.benchmarkValueBounds(line, candidate?.value || target.value) : null;
      const valueCrop = key === 'containerId'
        ? crop
        : valueBounds
        ? this.benchmarkLineCrop(valueBounds, this.previewImage()?.nativeElement.naturalWidth ?? 1, this.previewImage()?.nativeElement.naturalHeight ?? 1)
        : crop;
      let best = candidate;
      rescannedKeys.add(key);
      for (const scale of [2, 3, 4]) {
        const retry = await this.createBenchmarkScan(image, valueCrop, scale, MAX_CHECK_DIGIT_CROP_PIXELS, `${key} ${scale}x targeted rescan`);
        scans.push(retry.scan);
        const retryField = this.extractBenchmarkField(key, retry.lines, target.value, best?.value);
        const retryMatchesTarget = retryField?.value && this.benchmarkValue(retryField.value) === this.benchmarkValue(target.value);
        const bestMatchesTarget = best?.value && this.benchmarkValue(best.value) === this.benchmarkValue(target.value);
        if (retryField && (!best || (retryMatchesTarget && !bestMatchesTarget) || (retryMatchesTarget === bestMatchesTarget && (retryField.confidence ?? 0) > (best.confidence ?? 0)))) {
          fields = { ...fields, [key]: { ...fields[key], ...retryField } };
        }
        best = fields[key] ?? best;
        if (best?.value && (best.confidence ?? 0) >= (target.confidence ?? 0)
          && this.benchmarkValue(best.value) === this.benchmarkValue(target.value)) break;
      }
    }

    return {
      durationMs: Math.round(performance.now() - startedAt),
      firstScanFields,
      fields,
      rescannedKeys: [...rescannedKeys],
      scans,
    };
  }

  private async createBenchmarkScan(image: Blob, crop: CropRect, scale: number, maximumPixels: number, label: string): Promise<{ lines: OcrLine[]; scan: RawScan }> {
    const pass = await this.createCropPass(image, crop, scale, undefined, maximumPixels);
    const startedAt = performance.now();
    try {
      const lines = this.deduplicateLines((await this.detectWithTimeout(pass.url)).map((line) => ({
        ...line,
        box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
      })));
      return {
        lines,
        scan: {
          label,
          lines: lines.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
          durationMs: Math.round(performance.now() - startedAt),
          pixelCount: pass.pixelCount,
        },
      };
    } finally {
      if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
    }
  }

  private benchmarkLineForField(lines: OcrLine[], candidateValue: string | undefined, baselineValue: string): OcrLine | undefined {
    const candidates = [candidateValue, baselineValue]
      .filter((value): value is string => Boolean(value))
      .map((value) => this.benchmarkValue(value))
      .filter(Boolean);
    return lines
      .filter((line) => {
        const text = this.benchmarkValue(line.text);
        return candidates.some((candidate) => text.includes(candidate) || candidate.includes(text));
      })
      .sort((first, second) => second.mean - first.mean)[0];
  }

  private benchmarkLineCrop(bounds: BoxBounds, imageWidth: number, imageHeight: number): CropRect {
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const horizontalPadding = Math.max(24, width * 0.2);
    const verticalPadding = Math.max(24, height * 1.25);
    const left = Math.max(0, bounds.left - horizontalPadding);
    const top = Math.max(0, bounds.top - verticalPadding);
    const right = Math.min(imageWidth, bounds.right + horizontalPadding);
    const bottom = Math.min(imageHeight, bounds.bottom + verticalPadding);
    return { x: left / imageWidth, y: top / imageHeight, width: (right - left) / imageWidth, height: (bottom - top) / imageHeight };
  }

  private benchmarkValueBounds(line: OcrLine, value: string): BoxBounds | null {
    const bounds = this.boxBounds(line.box);
    if (!bounds) return null;
    const compactValue = this.benchmarkValue(value);
    const compactText = this.benchmarkValue(line.text);
    if (!compactValue || !compactText) return bounds;
    const start = compactText.indexOf(compactValue);
    if (start < 0) return bounds;
    const end = start + compactValue.length;
    return {
      left: bounds.left + (bounds.right - bounds.left) * start / compactText.length,
      top: bounds.top,
      right: bounds.left + (bounds.right - bounds.left) * end / compactText.length,
      bottom: bounds.bottom,
    };
  }

  private extractBenchmarkField(key: FieldKey, lines: OcrLine[], baselineValue: string, previousValue?: string): BenchmarkField | undefined {
    const expected = [baselineValue, previousValue]
      .filter((value): value is string => Boolean(value))
      .map((value) => this.benchmarkValue(value));
    const ranked = lines
      .map((line) => ({ line, text: this.benchmarkValue(line.text) }))
      .filter(({ text }) => text)
      .sort((first, second) => {
        const firstMatch = expected.some((value) => first.text.includes(value));
        const secondMatch = expected.some((value) => second.text.includes(value));
        return Number(secondMatch) - Number(firstMatch) || second.line.mean - first.line.mean;
      });
    const selected = ranked[0];
    if (!selected) return undefined;
    if (key === 'containerId') {
      const id = selected.line.text.match(/[A-Z]{3}[UJZ]\s*(?:\d\s*){6,7}/i)?.[0]?.replace(/\s/g, '').toUpperCase();
      return id ? { value: id, confidence: selected.line.mean } : undefined;
    }
    if (key === 'isoCode') {
      const iso = selected.line.text.match(/\b\d{2}[A-Z][0-9A-Z]\b/i)?.[0]?.toUpperCase();
      return iso ? { value: iso, confidence: selected.line.mean } : undefined;
    }
    const numeric = selected.line.text.match(/\d[\d ,.]*\d|\d+/)?.[0]?.trim();
    return { value: numeric ?? selected.line.text.trim(), confidence: selected.line.mean };
  }

  private benchmarkValue(value: string): string {
    return value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  }

  */
  private lineForField(lines: OcrLine[], value: string): OcrLine | undefined {
    const expected = value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return lines
      .filter((line) => {
        const text = line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        return expected && (text.includes(expected) || expected.includes(text));
      })
      .sort((first, second) => second.mean - first.mean)[0];
  }

  private valueBounds(line: OcrLine, value: string): BoxBounds | null {
    const bounds = this.boxBounds(line.box);
    if (!bounds) return null;
    const compactValue = value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const compactText = line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const start = compactText.indexOf(compactValue);
    if (start < 0 || !compactValue || !compactText) return bounds;
    const end = start + compactValue.length;
    return {
      left: bounds.left + (bounds.right - bounds.left) * start / compactText.length,
      top: bounds.top,
      right: bounds.left + (bounds.right - bounds.left) * end / compactText.length,
      bottom: bounds.bottom,
    };
  }

  private lineCrop(bounds: BoxBounds, imageWidth: number, imageHeight: number): CropRect {
    const width = Math.max(1, bounds.right - bounds.left);
    const height = Math.max(1, bounds.bottom - bounds.top);
    const horizontalPadding = Math.max(24, width * 0.2);
    const verticalPadding = Math.max(24, height * 1.25);
    const left = Math.max(0, bounds.left - horizontalPadding);
    const top = Math.max(0, bounds.top - verticalPadding);
    const right = Math.min(imageWidth, bounds.right + horizontalPadding);
    const bottom = Math.min(imageHeight, bounds.bottom + verticalPadding);
    return { x: left / imageWidth, y: top / imageHeight, width: (right - left) / imageWidth, height: (bottom - top) / imageHeight };
  }

  protected providerLabel(provider: ExecutionProvider): string {
    return provider === 'wasm' ? 'WASM' : provider === 'webgl' ? 'WebGL' : 'WebGPU';
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
    void this.ocrService.detectProviderCapabilities().then((capabilities) => this.providerCapabilities.set(capabilities));
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
    this.repairOpen.set(false);
    this.repairStrokes.set([]);
    this.repairRedoStack = [];
    this.repairDraft = null;
    this.cropRect.set(null);
    this.cropDraft.set(DEFAULT_CROP);
    this.unwarpSelectedRegion.set(false);
    this.unwarpRotation.set(0);
    this.clearCheckDigitPreview();
    this.selectedOcrLines.set([]);
    this.rawText.set([]);
    this.rawScans.set([]);
    this.rawScansCollapsed.set(false);
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
      approvalCode: { value: '' },
      applicableRegulations: { value: '' },
      tankCode: { value: '' },
      kemlerCode: { value: '' },
      unNumber: { value: '' },
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
    this.rawScansCollapsed.set(false);
    this.selectedOcrLines.set([]);
    this.clearCheckDigitPreview();
  }

  protected updateInferredContainerIdStem(value: string): void {
    const digit = this.inferredContainerIdDigit();
    this.updateField('containerId', `${value}${digit}`);
  }

  protected updateInferredContainerIdDigit(value: string): void {
    this.updateField('containerId', `${this.fields().containerId.value.slice(0, 10)}${value.slice(-1)}`);
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
         pixelCount: this.lastAutoCropPixelCount,
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
       const shouldRetryAutomaticCrop = Boolean(suggestedCrop && this.hasLowConfidenceForAutomaticCrop(fields));
         if (suggestedCrop && shouldRetryAutomaticCrop) {
           try {
             const retryStartedAt = performance.now();
             automaticRetryReason = this.lowConfidenceSummary(fields);
            this.status.set(`Low confidence detected in ${automaticRetryReason}. Retrying the automatic crop at 2x to improve recognition...`);
            const retryLines = await this.scanCropRegion(image, suggestedCrop, 2, MAX_MANUAL_RETRY_CROP_PIXELS, { retried: false });
            this.rawScans.update((scans) => [...scans, {
              label: '2x automatic crop',
              lines: retryLines.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
              durationMs: Math.round(performance.now() - retryStartedAt),
              pixelCount: this.lastCropPassPixelCount,
            }]);
           lines = this.selectBestOcrLines([lines, retryLines]);
           this.rawText.set(lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`));
           fields = this.mergeFieldsByConfidence(fields, this.extractFields(retryLines));
            this.fields.set(fields);
             suggestedCrop = await this.createSuggestedCrop(lines, fields.containerId.value || partialContainerId, image, {
               width: preview.naturalWidth,
               height: preview.naturalHeight,
             });
           } catch (error: unknown) {
            this.addDiagnostic('Automatic crop retry', 'The enlarged automatic crop could not be scanned.', this.errorMessage(error));
          }
        }
        if (partialContainerId && !this.validateContainerId(fields.containerId.value) && suggestedCrop) {
          this.fields.set(fields);
          this.selectedOcrLines.set(lines);
          await this.runCheckDigitScan(suggestedCrop, lines);
          fields = this.fields();
        }
       if (selection !== this.imageSelection || this.cropRect()) return;
      const duration = ` (${Math.round(performance.now() - startedAt)} ms)`;
       if (suggestedCrop) {
         this.cropDraft.set(suggestedCrop);
          const retryStatus = automaticRetryReason ? `\nAutomatic 2x scan ran because some fields had confidence below the 85% threshold: ${automaticRetryReason}.` : '';
           const completeContainerId = this.validateContainerId(fields.containerId.value);
           this.status.set(completeContainerId
             ? `Container ID located${duration}: ${this.formatContainerId(fields.containerId.value)}${retryStatus}\n`
             : partialContainerId
               ? `Partial container ID located: ${this.formatContainerId(partialContainerId)}${retryStatus}`
               : `Container ID located${duration}.${retryStatus}\n`);
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
    this.lastAutoCropPixelCount = pass.pixelCount;
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

  private async detectWithTimeout(url: string, provider = this.selectedProvider()) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.ocrService.detect(url, provider),
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
    this.lastCropPassPixelCount = pass.pixelCount;
    try {
      return this.deduplicateLines((await this.detectWithRecovery(pass.url, recovery)).map((line) => ({
        ...line,
        box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
      })));
    } finally {
      if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
    }
  }

  private async scanDataPlateCrop(image: Blob, crop: CropRect, scale: DataPlateScale, recovery: { retried: boolean }): Promise<OcrLine[]> {
    const variants: Array<{ preprocess: DataPlatePreprocess; label: string }> = [
      { preprocess: 'original', label: scale === 'original' ? 'Data plate original size' : `Data plate ${scale.replace('-', ' ')}` },
      { preprocess: 'contrast', label: 'Data plate grayscale contrast' },
      { preprocess: 'invert-contrast', label: 'Data plate inverted grayscale contrast' },
      { preprocess: 'clahe-dark', label: 'Data plate CLAHE local contrast' },
      { preprocess: 'clahe-light', label: 'Data plate inverted CLAHE local contrast' },
      { preprocess: 'blackhat', label: 'Data plate black-hat morphology' },
      { preprocess: 'illumination', label: 'Data plate illumination correction' },
      { preprocess: 'unsharp', label: 'Data plate unsharp mask' },
      { preprocess: 'closing', label: 'Data plate morphological closing' },
      { preprocess: 'adaptive-dark', label: 'Data plate adaptive dark text' },
      { preprocess: 'adaptive-light', label: 'Data plate adaptive light text' },
    ];
    const allLines: OcrLine[] = [];
    const scans: RawScan[] = [];

    for (const variant of variants) {
      const pass = await this.createCropPass(image, crop, this.dataPlateOutputScale(scale), undefined, MAX_MANUAL_CROP_PIXELS, false, 0, 0, variant.preprocess);
      try {
        const startedAt = performance.now();
        const detected = await this.detectWithRecovery(pass.url, recovery);
        const lines = detected.map((line) => ({
          ...line,
          box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
        }));
        allLines.push(...lines);
        scans.push({
          label: variant.label,
          lines: lines.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
          durationMs: Math.round(performance.now() - startedAt),
          pixelCount: pass.pixelCount,
        });
      } finally {
        if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
      }
    }

    const sourceSize = this.previewImage()?.nativeElement;
    if (sourceSize?.naturalWidth && sourceSize.naturalHeight) {
      const engravedDate = await this.scanEngravedMonthYear(image, crop, recovery);
      allLines.push(...engravedDate.lines);
      scans.push(...engravedDate.scans);
      const engraved = await this.scanEngravedGapCrops(image, crop, allLines, sourceSize.naturalWidth, sourceSize.naturalHeight, recovery);
      allLines.push(...engraved.lines);
      scans.push(...engraved.scans);
    }

    const lines = this.deduplicateLines(allLines);
    this.rawScans.set(this.repairStrokes().length
      ? scans.map((scan) => ({ ...scan, label: `${scan.label} (manual repair)` }))
      : scans);
    return lines;
  }

  private async scanEngravedMonthYear(image: Blob, selectedCrop: CropRect, recovery: { retried: boolean }): Promise<{ lines: OcrLine[]; scans: RawScan[] }> {
    const slotLines: OcrLine[][] = [[], [], [], []];
    const scans: RawScan[] = [];
    const preprocesses: Array<{ preprocess: DataPlatePreprocess; label: string }> = [
      { preprocess: 'contrast', label: 'contrast' },
      { preprocess: 'clahe-dark', label: 'CLAHE local contrast' },
      { preprocess: 'clahe-light', label: 'inverted CLAHE local contrast' },
      { preprocess: 'blackhat', label: 'black-hat morphology' },
      { preprocess: 'illumination', label: 'illumination correction' },
      { preprocess: 'unsharp', label: 'unsharp mask' },
      { preprocess: 'closing', label: 'morphological closing' },
      { preprocess: 'adaptive-dark', label: 'adaptive dark' },
      { preprocess: 'adaptive-light', label: 'adaptive light' },
    ];

    for (let slot = 0; slot < 4; slot++) {
      const padding = 0.08;
      const left = slot / 4 + padding / 4;
      const right = (slot + 1) / 4 - padding / 4;
      const slotCrop: CropRect = {
        x: selectedCrop.x + selectedCrop.width * left,
        y: selectedCrop.y,
        width: selectedCrop.width * (right - left),
        height: selectedCrop.height,
      };

      for (const variant of preprocesses) {
        const pass = await this.createCropPass(image, slotCrop, 10, undefined, MAX_CHECK_DIGIT_CROP_PIXELS, false, 0, 0, variant.preprocess);
        try {
          const startedAt = performance.now();
          const detected = await this.detectWithRecovery(pass.url, recovery);
          const mapped = detected.map((line) => ({
            ...line,
            box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
          }));
          slotLines[slot].push(...mapped);
          scans.push({
            label: `Engraved MM YY character ${slot + 1} (${variant.label})`,
            lines: mapped.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
            durationMs: Math.round(performance.now() - startedAt),
            pixelCount: pass.pixelCount,
          });
        } finally {
          if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
        }
      }
    }

    const characters = slotLines.map((lines) => this.bestEngravedDigit(lines));
    const month = `${characters[0]?.digit ?? ''}${characters[1]?.digit ?? ''}`;
    const year = `${characters[2]?.digit ?? ''}${characters[3]?.digit ?? ''}`;
    if (!/^([0][1-9]|1[0-2])$/.test(month) || !/^\d{2}$/.test(year)) return { lines: [], scans };

    const confidence = Math.min(...characters.map((character) => character!.confidence));
    return {
      lines: [{ text: `${month} ${year}`, mean: confidence }],
      scans,
    };
  }

  private bestEngravedDigit(lines: OcrLine[]): { digit: string; confidence: number } | undefined {
    return lines
      .map((line) => {
        const normalized = line.text.toUpperCase().replace(/[^A-Z0-9]/g, '');
        const digit = normalized
          .replaceAll('O', '0')
          .replaceAll('Q', '0')
          .replaceAll('I', '1')
          .replaceAll('L', '1')
          .replaceAll('Z', '2')
          .replaceAll('S', '5')
          .replaceAll('G', '6')
          .replaceAll('T', '7')
          .replaceAll('B', '8')
          .match(/\d/)?.[0];
        return digit ? { digit, confidence: line.mean } : undefined;
      })
      .filter((candidate): candidate is { digit: string; confidence: number } => Boolean(candidate))
      .sort((first, second) => second.confidence - first.confidence)[0];
  }

  private async scanEngravedGapCrops(image: Blob, selectedCrop: CropRect, lines: OcrLine[], imageWidth: number, imageHeight: number, recovery: { retried: boolean }): Promise<{ lines: OcrLine[]; scans: RawScan[] }> {
    const anchors = lines.flatMap((line) => {
      const bounds = this.boxBounds(line.box);
      if (!bounds) return [];
      const matches = [...line.text.toUpperCase().matchAll(/5\s*Y(?:EAR)?|BAR\.?/g)];
      return matches.map((match) => {
        const start = (match.index ?? 0) / Math.max(1, line.text.length);
        const end = ((match.index ?? 0) + match[0].length) / Math.max(1, line.text.length);
        return {
          line,
          text: match[0].replace(/[^A-Z0-9]/g, ''),
          bounds: {
            left: bounds.left + (bounds.right - bounds.left) * start,
            right: bounds.left + (bounds.right - bounds.left) * end,
            top: bounds.top,
            bottom: bounds.bottom,
          },
        };
      });
    });
    const dateLabels = anchors.filter((item) => item.text === '5Y' || item.text === '5YEAR');
    const pressureLabels = anchors.filter((item) => item.text === 'BAR' || item.text === 'BAR.');
    const detectedLines: OcrLine[] = [];
    const scans: RawScan[] = [];

    for (const dateLabel of dateLabels) {
      const dateCenter = (dateLabel.bounds.top + dateLabel.bounds.bottom) / 2;
      const pressure = pressureLabels
        .filter((candidate) => candidate.bounds.left > dateLabel.bounds.right)
        .filter((candidate) => Math.abs((candidate.bounds.top + candidate.bounds.bottom) / 2 - dateCenter) <= (dateLabel.bounds.bottom - dateLabel.bounds.top) * 0.8)
        .sort((first, second) => first.bounds.left - second.bounds.left)[0];
      if (!pressure) continue;

      const rowHeight = Math.max(dateLabel.bounds.bottom - dateLabel.bounds.top, pressure.bounds.bottom - pressure.bounds.top);
      const left = dateLabel.bounds.right + rowHeight * 0.35;
      const right = pressure.bounds.left - rowHeight * 0.35;
      const top = Math.max(0, dateCenter - rowHeight * 0.9);
      const bottom = Math.min(imageHeight, dateCenter + rowHeight * 0.9);
      if (right - left < rowHeight || bottom <= top) continue;
      const gapCrop: CropRect = {
        x: Math.max(selectedCrop.x, left / imageWidth),
        y: Math.max(selectedCrop.y, top / imageHeight),
        width: 0,
        height: 0,
      };
      gapCrop.width = Math.min(selectedCrop.x + selectedCrop.width, right / imageWidth) - gapCrop.x;
      gapCrop.height = Math.min(selectedCrop.y + selectedCrop.height, bottom / imageHeight) - gapCrop.y;
      if (gapCrop.width <= 0 || gapCrop.height <= 0) continue;

      const pass = await this.createCropPass(image, gapCrop, 10, undefined, MAX_CHECK_DIGIT_CROP_PIXELS, false, 0, 0, 'contrast');
      try {
        const startedAt = performance.now();
        const detected = await this.detectWithRecovery(pass.url, recovery);
        const mapped = detected.map((line) => ({
          ...line,
          box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
        }));
        detectedLines.push(...mapped);
        scans.push({
          label: 'Data plate engraved gap between 5 Y and bar (contrast)',
          lines: mapped.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
          durationMs: Math.round(performance.now() - startedAt),
          pixelCount: pass.pixelCount,
        });
      } finally {
        if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
      }
    }

    return { lines: detectedLines, scans };
  }

  private dataPlateOutputScale(scale: DataPlateScale): number {
    switch (scale) {
      case 'divide-2': return 0.5;
      case 'divide-3': return 1 / 3;
      case 'divide-4': return 0.25;
      case 'zoom-2': return 2;
      case 'zoom-3': return 3;
      case 'zoom-4': return 4;
      case 'zoom-5': return 5;
      case 'zoom-10': return 10;
      case 'zoom-20': return 20;
      default: return 1;
    }
  }

  private async runLowConfidenceFieldScans(image: Blob, lines: OcrLine[], fields: Record<FieldKey, ContainerField>): Promise<void> {
    const imageSize = this.previewImage()?.nativeElement;
    if (!imageSize?.naturalWidth || !imageSize.naturalHeight) return;
    for (const key of Object.keys(fields) as FieldKey[]) {
      const field = fields[key];
      if (key === 'containerId' || !field.value || field.confidence === undefined || field.confidence >= 0.85) continue;
      const line = this.lineForField(lines, field.value);
      const bounds = line ? this.boxBounds(line.box) : null;
      if (!line || !bounds) continue;
      const valueBounds = this.valueBounds(line, field.value) ?? bounds;
      const valueCrop = this.lineCrop(valueBounds, imageSize.naturalWidth, imageSize.naturalHeight);
      const startedAt = performance.now();
      const pass = await this.createCropPass(image, valueCrop, 2, undefined, MAX_CHECK_DIGIT_CROP_PIXELS);
      try {
        const detected = await this.detectWithRecovery(pass.url, { retried: false });
        const retryFields = this.extractFields(detected);
        const retryField = retryFields[key];
        this.rawScans.update((scans) => [...scans, {
          label: `${key} individual rescan`,
          lines: detected.map((detectedLine) => ({ text: detectedLine.text, confidence: Math.round(detectedLine.mean * 100) })),
          durationMs: Math.round(performance.now() - startedAt),
          pixelCount: pass.pixelCount,
        }]);
        if (retryField.value && (retryField.confidence ?? 0) > (field.confidence ?? 0)) {
          this.fields.update((current) => ({ ...current, [key]: { ...current[key], ...retryField } }));
        }
      } finally {
        if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
      }
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
            pixelCount: pass.pixelCount,
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
    let pass: { url: string; revokeUrl: boolean; pixelCount: number } | null = null;
    try {
      this.status.set('Scanning the expected check-digit region...');
       pass = await this.createCheckDigitPass(image, region, 2);
      this.clearCheckDigitPreview();
      this.checkDigitPreviewUrl.set(pass.url);
      retainPass = true;
       const detected = await this.detectWithRecovery(pass.url, { retried: false });
       const approvalLine = detected.find((line) => /\b[0-9A-Z]{2}\s*[A-Z]\s*[0-9]\b\s+.+$/.test(line.text));
       const approvalMatch = approvalLine?.text.match(/\b([0-9A-Z]{2})\s*([A-Z])\s*([0-9])\b/);
       if (approvalLine && approvalMatch) {
         const regulations = approvalLine.text.replace(approvalMatch[0], '').replace(/^\s*[-:.]?\s*/, '').trim();
         this.fields.update((fields) => ({
           ...fields,
           approvalCode: { ...fields.approvalCode, value: `${approvalMatch[1]}${approvalMatch[2]}${approvalMatch[3]}`, confidence: approvalLine.mean },
           ...(regulations ? { applicableRegulations: { ...fields.applicableRegulations, value: regulations, confidence: approvalLine.mean } } : {}),
         }));
       }
       const scan = detected.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) }));
       this.rawScans.update((scans) => [...scans, {
          label: '2x container ID',
         lines: scan,
         durationMs: Math.round(performance.now() - startedAt),
         pixelCount: pass!.pixelCount,
       }]);
       let directlyDetected = this.applyCheckDigitCandidate(lines, detected, false);
       if (!directlyDetected) {
         if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
         retainPass = false;
         pass = await this.createCheckDigitPass(image, this.checkDigitDigitRegion(region), 3);
         this.clearCheckDigitPreview();
         this.checkDigitPreviewUrl.set(pass.url);
         retainPass = true;
         const digitDetected = await this.detectWithRecovery(pass.url, { retried: false });
         const digitScan = digitDetected.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) }));
          this.rawScans.update((scans) => [...scans, {
            label: '3x container ID check digit',
            lines: digitScan,
            durationMs: Math.round(performance.now() - startedAt),
            pixelCount: pass!.pixelCount,
          }]);
         directlyDetected = this.applyCheckDigitCandidate(lines, digitDetected, false);
         if (!directlyDetected) this.applyCheckDigitCandidate(lines, digitDetected);
       }
       this.status.set('Check-digit scan complete.');
    } catch (error: unknown) {
      this.addDiagnostic('Check digit OCR', 'The targeted check-digit scan could not be completed.', this.errorMessage(error));
    } finally {
      if (pass?.revokeUrl && !retainPass) URL.revokeObjectURL(pass.url);
      this.processing.set(false);
    }
  }

  private applyCheckDigitCandidate(lines: OcrLine[], detected: OcrLine[], allowInference = true): boolean {
     const stem = this.findCheckDigitStem(lines);
     if (!stem) return false;
    const current = this.fields().containerId;
    const candidates = detected
      .map((line) => {
        const normalized = line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const suffix = normalized.startsWith(stem) ? normalized.slice(stem.length) : '';
         const digits = normalized.match(/\d/g) ?? [];
         const stemTail = stem.slice(-3);
         const tailSuffix = normalized.startsWith(stemTail) && normalized.length === stemTail.length + 1
           ? normalized.slice(stemTail.length)
           : '';
         return {
           digit: /^\d$/.test(suffix) ? suffix : /^\d$/.test(tailSuffix) ? tailSuffix : digits.length === 1 ? digits[0] : undefined,
          confidence: line.mean,
        };
      })
      .filter((item): item is { digit: string; confidence: number } => Boolean(item.digit))
      .sort((first, second) => second.confidence - first.confidence);
    const candidate = candidates.find((item) => this.validateContainerId(stem + item.digit));
     if (!candidate && !allowInference) return false;
     const inferred = !candidate;
     const recoveredDigit = candidate?.digit ?? this.containerIdCheckDigit(stem);
     if (!recoveredDigit) return false;
     const recoveredConfidence = candidate?.confidence ?? this.containerIdConfidence(lines, stem) ?? 0;
     if (this.validateContainerId(current.value) && recoveredConfidence < (current.confidence ?? 0)) return false;
    this.fields.update((fields) => ({
       ...fields,
       containerId: { ...fields.containerId, value: stem + recoveredDigit, confidence: recoveredConfidence, inferred },
     }));
     return true;
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
     const verticalPadding = Math.max(4, idBounds.bottom - idBounds.top);
     const left = Math.max(cropBounds.left, idBounds.left - characterWidth * 0.5);
     const right = Math.min(cropBounds.right, stemRight + characterWidth * 2.8);
     const top = Math.max(cropBounds.top, idBounds.top - verticalPadding);
     const bottom = Math.min(cropBounds.bottom, idBounds.bottom + verticalPadding);
    if (right <= left || bottom <= top) return null;
     return { x: left / imageWidth, y: top / imageHeight, width: (right - left) / imageWidth, height: (bottom - top) / imageHeight };
   }

  private checkDigitDigitRegion(region: CropRect): CropRect {
    const digitWidth = region.width * 0.35;
    return {
      ...region,
      x: region.x + region.width - digitWidth,
      width: digitWidth,
    };
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

  private async createCheckDigitPass(image: Blob, region: CropRect, requestedScale = 2): Promise<{ url: string; revokeUrl: boolean; pixelCount: number }> {
    const decodedImage = await this.decodeImage(image);
    try {
      const sourceX = Math.round(region.x * decodedImage.width);
      const sourceY = Math.round(region.y * decodedImage.height);
      const sourceWidth = Math.max(1, Math.round(region.width * decodedImage.width));
      const sourceHeight = Math.max(1, Math.round(region.height * decodedImage.height));
       const scale = this.cropOutputScale(sourceWidth, sourceHeight, requestedScale, undefined, this.runtimeCropPixelBudget(MAX_CHECK_DIGIT_CROP_PIXELS));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Canvas 2D context is unavailable.');
        context.drawImage(decodedImage.source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Check-digit crop could not be created.')), 'image/png'));
        return { url: URL.createObjectURL(blob), revokeUrl: true, pixelCount: canvas.width * canvas.height };
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
      .filter(([key, field]) => key !== 'containerId' && field.value && field.confidence !== undefined && field.confidence < 0.85)
      .map(([key, field]) => `${labels[key] ?? key} ${Math.round((field.confidence ?? 0) * 100)}%`)
      .join(', ');
  }

  private hasLowConfidence(fields: Record<string, ContainerField>): boolean {
    return Object.values(fields).some((field) => field.value && field.confidence !== undefined && field.confidence < 0.85);
  }

  private hasLowConfidenceForAutomaticCrop(fields: Record<string, ContainerField>): boolean {
    return Object.entries(fields).some(([key, field]) => key !== 'containerId'
      && field.value && field.confidence !== undefined && field.confidence < 0.85);
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

  protected rawScanPixelSize(scan: RawScan): string {
    if (scan.pixelCount >= 1_000_000) return `${this.formatPixelValue(scan.pixelCount / 1_000_000)} MP`;
    if (scan.pixelCount >= 1_000) return `${this.formatPixelValue(scan.pixelCount / 1_000)} kpx`;
    return `${scan.pixelCount} px`;
  }

  private formatPixelValue(value: number): string {
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  }

  private async createSuggestedCrop(lines: OcrLine[], containerId: string, image: Blob, sourceSize?: { width: number; height: number }): Promise<CropRect | null> {
    const markingsBounds = this.suggestedMarkingBounds(lines, containerId);
    if (!markingsBounds) return null;

    const decodedImage = sourceSize ? null : await this.decodeImage(image);
    const width = sourceSize?.width ?? decodedImage!.width;
    const height = sourceSize?.height ?? decodedImage!.height;
    try {
      const padding = Math.max(24, Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top) * 0.08);
      const leftPadding = Math.max(48, Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top) * 0.12);
      const markingSize = Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top);
      const isUnTank = lines.some((line) => /\bUN\s*TANK\b/i.test(line.text));
      const rightPadding = isUnTank ? Math.max(48, markingSize * 0.07) : Math.max(72, markingSize * 0.12);
      const left = Math.max(0, markingsBounds.left - leftPadding);
      const top = Math.max(0, markingsBounds.top - padding);
      const right = Math.min(width, markingsBounds.right + rightPadding);
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

  private async createCropPass(image: Blob, crop: CropRect, scale: number, maximumWidth?: number, maximumPixels?: number, unwarp = false, rotation = 0, curvature = 0, preprocess: DataPlatePreprocess = 'original'): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean; pixelCount: number }> {
    const decodedImage = await this.decodeImage(image);
    try {
      return await this.createCropPassFromSource(decodedImage.source, decodedImage.width, decodedImage.height, crop, scale, maximumWidth, maximumPixels, unwarp, rotation, curvature, preprocess);
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

  private async createCropPassFromSource(source: CanvasImageSource, imageWidth: number, imageHeight: number, crop: CropRect, scale: number, maximumWidth?: number, maximumPixels?: number, unwarp = false, rotation = 0, curvature = 0, preprocess: DataPlatePreprocess = 'original'): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean; pixelCount: number }> {
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
      context.imageSmoothingEnabled = preprocess === 'original';
      if (unwarp) {
        this.drawCylindricalUnwarp(context, source, sourceX, sourceY, sourceWidth, sourceHeight, baseWidth, baseHeight, canvas.width, canvas.height, radians, curvature);
      } else {
        context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, baseWidth, baseHeight);
      }
      if (!unwarp && this.repairStrokes().length) {
        this.drawRepairStrokesOnCrop(context, this.repairStrokes(), sourceX, sourceY, sourceWidth, sourceHeight, baseWidth, baseHeight, imageWidth, imageHeight);
      }
      this.preprocessDataPlateCanvas(context, outputWidth, outputHeight, preprocess);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error('Manual crop could not be created.'));
      }, 'image/png'));
      return { url: URL.createObjectURL(blob), offsetX: sourceX, offsetY: sourceY, scale: outputScale, revokeUrl: true, pixelCount: outputWidth * outputHeight };
    } finally {
      // Reset dimensions to release this large backing store before the next image pass.
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  private preprocessDataPlateCanvas(context: CanvasRenderingContext2D, width: number, height: number, preprocess: DataPlatePreprocess): void {
    if (preprocess === 'original') return;
    const image = context.getImageData(0, 0, width, height);
    const { data } = image;
    const grayscale = new Uint8Array(width * height);
      for (let index = 0; index < grayscale.length; index++) {
        const pixel = index * 4;
        grayscale[index] = Math.round(data[pixel] * 0.299 + data[pixel + 1] * 0.587 + data[pixel + 2] * 0.114);
      }

      if (preprocess === 'clahe-dark' || preprocess === 'clahe-light') {
        this.applyClahe(context, image, grayscale, width, height, preprocess === 'clahe-light');
        return;
      }

      if (preprocess === 'blackhat' || preprocess === 'illumination' || preprocess === 'unsharp' || preprocess === 'closing') {
        this.applyAdditionalEnhancement(context, image, grayscale, width, height, preprocess);
        return;
      }

      if (preprocess === 'contrast' || preprocess === 'invert-contrast') {
      for (let index = 0; index < grayscale.length; index++) {
        const source = preprocess === 'invert-contrast' ? 255 - grayscale[index] : grayscale[index];
        const value = Math.max(0, Math.min(255, Math.round((source - 128) * 1.8 + 128)));
        const pixel = index * 4;
        data[pixel] = value;
        data[pixel + 1] = value;
        data[pixel + 2] = value;
      }
      context.putImageData(image, 0, 0);
      return;
    }

    // Adaptive thresholding keeps engraved strokes visible despite the plate's uneven lighting.
    const integral = new Uint32Array((width + 1) * (height + 1));
    for (let y = 1; y <= height; y++) {
      let rowSum = 0;
      for (let x = 1; x <= width; x++) {
        rowSum += grayscale[(y - 1) * width + x - 1];
        const integralIndex = y * (width + 1) + x;
        integral[integralIndex] = rowSum + integral[integralIndex - width - 1];
      }
    }
    const radius = Math.max(4, Math.round(Math.min(width, height) / 150));
    for (let y = 0; y < height; y++) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height - 1, y + radius);
      for (let x = 0; x < width; x++) {
        const left = Math.max(0, x - radius);
        const right = Math.min(width - 1, x + radius);
        const area = (right - left + 1) * (bottom - top + 1);
        const sum = integral[(bottom + 1) * (width + 1) + right + 1]
          - integral[top * (width + 1) + right + 1]
          - integral[(bottom + 1) * (width + 1) + left]
          + integral[top * (width + 1) + left];
        const localMean = sum / area;
        const value = grayscale[y * width + x];
        const isText = preprocess === 'adaptive-dark' ? value < localMean - 8 : value > localMean + 4;
        const output = isText ? 0 : 255;
        const pixel = (y * width + x) * 4;
        data[pixel] = output;
        data[pixel + 1] = output;
        data[pixel + 2] = output;
        data[pixel + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  }

  private applyAdditionalEnhancement(context: CanvasRenderingContext2D, image: ImageData, grayscale: Uint8Array, width: number, height: number, preprocess: Exclude<DataPlatePreprocess, 'original' | 'contrast' | 'invert-contrast' | 'clahe-dark' | 'clahe-light' | 'adaptive-dark' | 'adaptive-light'>): void {
    const radius = preprocess === 'illumination' ? Math.max(2, Math.min(8, Math.round(Math.min(width, height) / 60))) : 1;
    const local = new Uint8Array(grayscale.length);
    const closed = new Uint8Array(grayscale.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let maximum = 0;
        let sum = 0;
        let count = 0;
        for (let offsetY = -radius; offsetY <= radius; offsetY++) {
          for (let offsetX = -radius; offsetX <= radius; offsetX++) {
            const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
            const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
            const sample = grayscale[sampleY * width + sampleX];
            maximum = Math.max(maximum, sample);
            sum += sample;
            count++;
          }
        }
        const index = y * width + x;
        local[index] = Math.round(sum / count);
        closed[index] = maximum;
      }
    }
    if (preprocess === 'blackhat' || preprocess === 'closing') {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          let minimum = 255;
          for (let offsetY = -radius; offsetY <= radius; offsetY++) {
            for (let offsetX = -radius; offsetX <= radius; offsetX++) {
              const sampleX = Math.max(0, Math.min(width - 1, x + offsetX));
              const sampleY = Math.max(0, Math.min(height - 1, y + offsetY));
              minimum = Math.min(minimum, closed[sampleY * width + sampleX]);
            }
          }
          closed[y * width + x] = minimum;
        }
      }
      }

    if (preprocess === 'blackhat') {
      for (let index = 0; index < grayscale.length; index++) local[index] = Math.min(255, (closed[index] - grayscale[index]) * 4);
    } else if (preprocess === 'illumination') {
      for (let index = 0; index < grayscale.length; index++) local[index] = Math.max(0, Math.min(255, grayscale[index] - local[index] + 128));
    } else if (preprocess === 'unsharp') {
      for (let index = 0; index < grayscale.length; index++) local[index] = Math.max(0, Math.min(255, Math.round(grayscale[index] + (grayscale[index] - local[index]) * 1.5)));
    } else {
      for (let index = 0; index < grayscale.length; index++) local[index] = Math.max(0, Math.min(255, Math.round((closed[index] - 128) * 1.8 + 128)));
    }

    for (let index = 0; index < local.length; index++) {
      const pixel = index * 4;
      image.data[pixel] = local[index];
      image.data[pixel + 1] = local[index];
      image.data[pixel + 2] = local[index];
      image.data[pixel + 3] = 255;
    }
    context.putImageData(image, 0, 0);
  }

  private applyClahe(context: CanvasRenderingContext2D, image: ImageData, grayscale: Uint8Array, width: number, height: number, invert: boolean): void {
    const openCv = (globalThis as typeof globalThis & { cv?: OpenCvApi }).cv;
    if (!openCv?.Size || (!openCv.createCLAHE && !openCv.CLAHE)) {
      this.applyLocalClahe(context, image, grayscale, width, height, invert);
      return;
    }

    const source = openCv.matFromImageData(image);
    const gray = new openCv.Mat();
    const enhanced = new openCv.Mat();
    const tileGridSize = new openCv.Size(8, 8);
    const clahe = openCv.createCLAHE
      ? openCv.createCLAHE(2.5, tileGridSize)
      : new openCv.CLAHE!(2.5, tileGridSize);
    try {
      openCv.cvtColor(source, gray, openCv.COLOR_RGBA2GRAY);
      clahe.apply(gray, enhanced);
      for (let index = 0; index < width * height; index++) {
        const value = invert ? 255 - enhanced.data[index] : enhanced.data[index];
        const pixel = index * 4;
        image.data[pixel] = value;
        image.data[pixel + 1] = value;
        image.data[pixel + 2] = value;
        image.data[pixel + 3] = 255;
      }
      context.putImageData(image, 0, 0);
    } finally {
      clahe.delete();
      enhanced.delete();
      gray.delete();
      source.delete();
    }
  }

  private applyLocalClahe(context: CanvasRenderingContext2D, image: ImageData, grayscale: Uint8Array, width: number, height: number, invert: boolean): void {
    const columns = Math.min(8, width);
    const rows = Math.min(8, height);
    const tileWidth = Math.ceil(width / columns);
    const tileHeight = Math.ceil(height / rows);

    for (let tileY = 0; tileY < rows; tileY++) {
      for (let tileX = 0; tileX < columns; tileX++) {
        const left = tileX * tileWidth;
        const top = tileY * tileHeight;
        const right = Math.min(width, left + tileWidth);
        const bottom = Math.min(height, top + tileHeight);
        const histogram = new Uint32Array(256);
        const area = (right - left) * (bottom - top);
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) histogram[grayscale[y * width + x]]++;
        }
        const clipLimit = Math.max(1, Math.floor(2.5 * area / 256));
        let excess = 0;
        for (let bin = 0; bin < 256; bin++) {
          if (histogram[bin] > clipLimit) {
            excess += histogram[bin] - clipLimit;
            histogram[bin] = clipLimit;
          }
        }
        const redistribution = Math.floor(excess / 256);
        for (let bin = 0; bin < 256; bin++) histogram[bin] += redistribution;
        let remainder = excess % 256;
        for (let bin = 0; remainder > 0; bin = (bin + 1) % 256, remainder--) histogram[bin]++;

        let cumulative = 0;
        let firstNonZero = -1;
        const lookup = new Uint8Array(256);
        for (let bin = 0; bin < 256; bin++) {
          cumulative += histogram[bin];
          if (firstNonZero < 0 && histogram[bin] > 0) firstNonZero = cumulative;
          lookup[bin] = firstNonZero < 0 || area === firstNonZero
            ? bin
            : Math.round((cumulative - firstNonZero) * 255 / (area - firstNonZero));
        }
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) {
            const source = lookup[grayscale[y * width + x]];
            const value = invert ? 255 - source : source;
            const pixel = (y * width + x) * 4;
            image.data[pixel] = value;
            image.data[pixel + 1] = value;
            image.data[pixel + 2] = value;
            image.data[pixel + 3] = 255;
          }
        }
      }
    }
    context.putImageData(image, 0, 0);
  }

  private drawRepairStrokesOnCrop(context: CanvasRenderingContext2D, strokes: RepairStroke[], sourceX: number, sourceY: number, sourceWidth: number, sourceHeight: number, outputWidth: number, outputHeight: number, imageWidth: number, imageHeight: number): void {
    context.save();
    context.beginPath();
    context.rect(0, 0, outputWidth, outputHeight);
    context.clip();
    for (const stroke of strokes) {
      const mapped: RepairStroke = {
        ...stroke,
        points: stroke.points.map((point) => ({
          x: (point.x * imageWidth - sourceX) / sourceWidth,
          y: (point.y * imageHeight - sourceY) / sourceHeight,
        })),
      };
      this.drawRepairStroke(context, mapped, outputWidth, outputHeight, Math.min(outputWidth / sourceWidth, outputHeight / sourceHeight));
    }
    context.restore();
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
        unTank: {
          approvalCode: fields.approvalCode,
          applicableRegulations: fields.applicableRegulations,
          tankCode: fields.tankCode,
          kemlerCode: fields.kemlerCode,
          unNumber: fields.unNumber,
        },
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
      approvalCode: { value: '' }, applicableRegulations: { value: '' }, tankCode: { value: '' },
      kemlerCode: { value: '' }, unNumber: { value: '' },
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
    const unTankIndex = text.findIndex((line) => /\bUN\s*TANK\b/.test(line.normalized));
    const isoLine = unTankIndex < 0 ? find(/\b[0-9]{2}[A-Z][0-9A-Z]\b/) : undefined;
    if (isoLine) {
      fields.isoCode = { value: isoLine.normalized.match(/\b[0-9]{2}[A-Z][0-9A-Z]\b/)![0], confidence: isoLine.mean };
    }

    if (unTankIndex >= 0) {
      const tankLine = text[unTankIndex];
      const tankRemainder = tankLine.normalized.split(/\bUN\s*TANK\b/)[1]?.replace(/^\s*[:.-]?\s*/, '').trim() ?? '';
      const approvalLine = text.find((line) => /\b[0-9A-Z]{2}\s*[A-Z]\s*[0-9]\b\s+.+$/.test(line.normalized));
      const approvalMatch = approvalLine?.normalized.match(/\b([0-9A-Z]{2})\s*([A-Z])\s*([0-9])\b\s+(.+)$/);
      const regulationsValue = approvalMatch?.[4].replace(/^APPLICABLE\s+REGULATIONS\s*:?-?\s*/i, '').trim() ?? '';
      const tankCodeText = tankRemainder
        .replace(approvalMatch?.[0] ?? '', '')
        .trim();
      const tankCode = tankCodeText.match(/^([0-9A-Z][0-9A-Z./-]*)/)?.[1];
      if (approvalMatch && approvalLine) fields.approvalCode = { value: `${approvalMatch[1]}${approvalMatch[2]}${approvalMatch[3]}`, confidence: approvalLine.mean };
      if (regulationsValue && approvalLine) fields.applicableRegulations = { value: regulationsValue, confidence: approvalLine.mean };
      if (tankCode) fields.tankCode = { value: tankCode, confidence: tankLine.mean };

      const parseTankWeight = (line: typeof text[number]) => {
        const match = line.normalized.match(/(\d[\d ,.]*?)\s*KG\s*\/\s*(\d[\d ,.]*?)\s*[A-Z]+\b/);
        if (!match) return undefined;
        return {
          line,
          kg: { value: match[1].trim() },
          lb: { value: match[2].trim() },
        };
      };
      const tankWeightRows = text.flatMap((line) => {
        const match = parseTankWeight(line);
        return match ? [match] : [];
      });
      const gross = tankWeightRows[0];
      const tare = tankWeightRows[1];
      const capacityPattern = /(\d[\d ,.]*?)\s*L\b[^\d]*(\d[\d ,.]*?)\s*US\s*GAL\b/;
      let capacityIndex = -1;
      let capacityEndIndex = -1;
      let capacity: RegExpMatchArray | undefined;
      for (let index = 0; index < text.length; index++) {
        const sameLine = text[index].normalized.match(capacityPattern);
        if (sameLine) {
          capacityIndex = index;
          capacityEndIndex = index;
          capacity = sameLine;
          break;
        }
        const nextLine = text[index + 1];
        if (!nextLine) continue;
        const combined = `${text[index].normalized} ${nextLine.normalized}`.match(capacityPattern);
        if (combined) {
          capacityIndex = index;
          capacityEndIndex = index + 1;
          capacity = combined;
          break;
        }
      }
      const setTankWeight = (pair: ReturnType<typeof parseTankWeight>, kgKey: 'mpgmKg' | 'tareKg', lbKey: 'mpgmLb' | 'tareLb', line: typeof text[number] | undefined) => {
        if (!pair) return;
        fields[kgKey] = { value: pair.kg.value, unit: 'KG', confidence: line?.mean };
        fields[lbKey] = { value: pair.lb.value, unit: 'LB', confidence: line?.mean };
      };
      setTankWeight(gross, 'mpgmKg', 'mpgmLb', gross?.line);
      setTankWeight(tare, 'tareKg', 'tareLb', tare?.line);
      if (capacityIndex >= 0 && capacity) {
        const liters = capacity[1].trim().match(/[\d,.]+$/)?.[0] ?? capacity[1].trim();
        const gallons = capacity[2].trim().match(/[\d,.]+$/)?.[0] ?? capacity[2].trim();
        fields.capacityLiters = { value: liters, unit: 'L', confidence: text[capacityIndex].mean };
        fields.capacityUsGallons = { value: gallons, unit: 'US GAL', confidence: text[capacityIndex].mean };
      }
      const kemlerLine = capacityEndIndex >= 0 ? text[capacityEndIndex + 1] : undefined;
      const unNumberLine = capacityEndIndex >= 0 ? text[capacityEndIndex + 2] : undefined;
      if (kemlerLine) fields.kemlerCode = { value: kemlerLine.normalized.trim(), confidence: kemlerLine.mean };
      if (unNumberLine) fields.unNumber = { value: unNumberLine.normalized.replace(/^UN\s*/, '').trim(), confidence: unNumberLine.mean };
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
    if (unTankIndex < 0) {
      fields.mpgmKg = { value: mpgmKg?.value ?? '', unit: 'KG', confidence: mpgmKg?.confidence, inferred: mpgmKg?.inferred };
      fields.mpgmLb = { value: mpgmLb?.value ?? '', unit: 'LB', confidence: mpgmLb?.confidence, inferred: mpgmLb?.inferred };
      fields.tareKg = { value: tareKg?.value ?? '', unit: 'KG', confidence: tareKg?.confidence, inferred: tareKg?.inferred };
      fields.tareLb = { value: tareLb?.value ?? '', unit: 'LB', confidence: tareLb?.confidence, inferred: tareLb?.inferred };
    }
    fields.payloadKg = payloadKg
      ? { value: payloadKg.value, unit: 'KG', confidence: payloadKg.confidence, inferred: payloadKg.inferred }
      : { value: '', unit: 'KG' };
    fields.payloadLb = payloadLb
      ? { value: payloadLb.value, unit: 'LB', confidence: payloadLb.confidence, inferred: payloadLb.inferred }
      : { value: '', unit: 'LB' };
    this.recoverMissingWeightRows(fields, text);
    if (unTankIndex < 0) {
      fields.capacityLiters = { value: capacityLiters?.value ?? '', unit: 'L', confidence: capacityLiters?.confidence };
      fields.capacityUsGallons = { value: capacityUsGallons?.value ?? '', unit: 'US GAL', confidence: capacityUsGallons?.confidence };
    }
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
    const grossIndex = lines.findIndex((line) => /\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR\.?/.test(line.normalized));
    const unlabeledRows = lines
      .slice(grossIndex + 1)
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
    const kgRows = unlabeledRows.filter((row) => row.kg);
    const firstKgIndex = unlabeledRows.findIndex((row) => row.kg);
    const firstKgHasLb = firstKgIndex >= 0 && Boolean(unlabeledRows[firstKgIndex].lb);
    const lbRows = unlabeledRows.filter((row, index) => row.lb && (firstKgHasLb ? index >= firstKgIndex : index > firstKgIndex));
    recover(kgRows[0], 'tareKg', kgRows[0]?.kg ?? null);
    recover(kgRows[1], 'payloadKg', kgRows[1]?.kg ?? null);
    if (lbRows[0]?.lb && !fields.tareLb.value) fields.tareLb = { value: lbRows[0].lb[1].trim(), unit: 'LB', confidence: lbRows[0].line.mean, inferred: true };
    if (lbRows[1]?.lb && !fields.payloadLb.value) fields.payloadLb = { value: lbRows[1].lb[1].trim(), unit: 'LB', confidence: lbRows[1].line.mean, inferred: true };
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
