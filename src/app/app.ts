import { Component, ElementRef, computed, signal, viewChild } from '@angular/core';
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

type ProcessingMode = 'full-photo' | 'guided-crop';
type FieldKey = 'containerId' | 'mgw' | 'tare' | 'payload' | 'cuCap';

interface ContainerField {
  value: string;
  unit?: string;
  confidence?: number;
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
  protected readonly processingMode = signal<ProcessingMode>('full-photo');
  protected readonly cameraOpen = signal(false);
  protected readonly processing = signal(false);
  protected readonly status = signal('Choose a container image to begin.');
  protected readonly diagnostics = signal<Diagnostic[]>([]);
  protected readonly rawText = signal<string[]>([]);
  protected readonly fields = signal<Record<FieldKey, ContainerField>>({
    containerId: { value: '' },
    mgw: { value: '', unit: 'KG' },
    tare: { value: '', unit: 'KG' },
    payload: { value: '', unit: 'KG' },
    cuCap: { value: '', unit: 'CU.M' },
  });
  protected readonly containerIdValid = computed(() => this.validateContainerId(this.fields().containerId.value));
  protected readonly hasImage = computed(() => this.previewUrl() !== null);

  private stream: MediaStream | null = null;
  private ocr: Awaited<ReturnType<typeof Ocr.create>> | null = null;

  protected openFilePicker(): void {
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

  protected async openCamera(): Promise<void> {
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

  protected clearImage(): void {
    this.closeCamera();
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    this.previewUrl.set(null);
    this.imageBlob.set(null);
    this.sourceName.set('');
    this.rawText.set([]);
    this.status.set('Choose a container image to begin.');
  }

  protected setMode(mode: ProcessingMode): void {
    this.processingMode.set(mode);
  }

  protected updateField(key: FieldKey, value: string): void {
    this.fields.update((fields) => ({ ...fields, [key]: { ...fields[key], value } }));
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
    const imageUrl = this.previewUrl();
    if (!imageUrl) {
      this.processing.set(false);
      this.addDiagnostic('Image input', 'The selected image preview is unavailable. Choose the image again.');
      return;
    }
    try {
      this.status.set('Loading local PaddleOCR models...');
      const ocr = await this.getOcr();
      this.status.set('Detecting painted text regions...');
      const lines = await ocr.detect(imageUrl);
      const rawText = lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`);
      this.rawText.set(rawText);
      this.fields.set(this.extractFields(lines));
      this.status.set(`OCR complete. Found ${lines.length} text region${lines.length === 1 ? '' : 's'}. Review the fields before exporting.`);
      this.processing.set(false);
    } catch (error: unknown) {
      this.processing.set(false);
      this.addDiagnostic('ONNX OCR', 'Local OCR could not process this image.', this.errorMessage(error));
    }
  }

  protected exportJson(): void {
    const fields = this.fields();
    const warnings = this.diagnostics().map((diagnostic) => `${diagnostic.stage}: ${diagnostic.message}`);
    if (fields.containerId.value && !this.containerIdValid()) {
      warnings.push('Container ID does not pass ISO 6346 format and check-digit validation.');
    }
    const payload = {
      source: {
        fileName: this.sourceName(),
        processedAt: new Date().toISOString(),
        processingMode: this.processingMode(),
      },
      container: {
        id: { ...fields.containerId, iso6346Valid: this.containerIdValid() },
        mgw: fields.mgw,
        tare: fields.tare,
        payload: fields.payload,
        cuCap: fields.cuCap,
      },
      warnings,
      rawText: this.rawText(),
    };
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.sourceName().replace(/\.[^.]+$/, '') || 'container'}-ocr.json`;
    link.click();
    URL.revokeObjectURL(url);
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
  }

  private useImage(image: Blob, name: string): void {
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    this.imageBlob.set(image);
    this.previewUrl.set(URL.createObjectURL(image));
    this.sourceName.set(name);
    this.status.set('Image ready. Select a processing mode and run OCR.');
    this.rawText.set([]);
  }

  private async getOcr(): Promise<Awaited<ReturnType<typeof Ocr.create>>> {
    if (this.ocr) {
      return this.ocr;
    }
    ort.env.wasm.wasmPaths = '/ort/';
    ort.env.wasm.numThreads = crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    this.ocr = await Ocr.create({
      models: {
        detectionPath: '/models/ch_PP-OCRv4_det_infer.onnx',
        recognitionPath: '/models/ch_PP-OCRv4_rec_infer.onnx',
        dictionaryPath: '/models/ppocr_keys_v1.txt',
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

  private extractFields(lines: Array<{ text: string; mean: number }>): Record<FieldKey, ContainerField> {
    const fields: Record<FieldKey, ContainerField> = {
      containerId: { value: '' }, mgw: { value: '', unit: 'KG' }, tare: { value: '', unit: 'KG' },
      payload: { value: '', unit: 'KG' }, cuCap: { value: '', unit: 'CU.M' },
    };
    const text = lines.map((line) => ({ ...line, normalized: line.text.toUpperCase().replace(/[|]/g, 'I') }));
    const find = (pattern: RegExp) => text.find((line) => pattern.test(line.normalized));
    const numberAfter = (line: typeof text[number] | undefined, label: string) => {
      if (!line) return undefined;
      const value = line.normalized.match(new RegExp(`${label}[^0-9]*(\\d[\\d ,.]+)`));
      return value?.[1].replace(/[, ]/g, '');
    };
    const idLine = find(/[A-Z]{3}[UJZ][\s-]*\d{6}[\s-]*\d/);
    if (idLine) {
      fields.containerId = { value: idLine.normalized.match(/[A-Z]{3}[UJZ][\s-]*\d{6}[\s-]*\d/)![0].replace(/[\s-]/g, ''), confidence: idLine.mean };
    }
    const mgw = find(/\bMGW\b|GROSS\s*WEIGHT/);
    const tare = find(/\bTARE\b/);
    const payload = find(/\bPAYLOAD\b|NET\s*WEIGHT/);
    const cuCap = find(/CU\.?\s*CAP|CUBIC/);
    fields.mgw = { value: numberAfter(mgw, 'MGW|GROSS\\s*WEIGHT') ?? '', unit: 'KG', confidence: mgw?.mean };
    fields.tare = { value: numberAfter(tare, 'TARE') ?? '', unit: 'KG', confidence: tare?.mean };
    fields.payload = { value: numberAfter(payload, 'PAYLOAD|NET\\s*WEIGHT') ?? '', unit: 'KG', confidence: payload?.mean };
    fields.cuCap = { value: numberAfter(cuCap, 'CU\\.?\\s*CAP|CUBIC') ?? '', unit: 'CU.M', confidence: cuCap?.mean };
    return fields;
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
