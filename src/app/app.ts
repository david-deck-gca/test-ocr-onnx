import { Component, ElementRef, computed, signal, viewChild } from '@angular/core';
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

type ProcessingMode = 'full-photo' | 'guided-crop';
type PayloadExportSource = 'detected' | 'calculated';
type FieldKey = 'containerId' | 'isoCode' | 'mpgmKg' | 'mpgmLb' | 'tareKg' | 'tareLb' | 'payloadKg' | 'payloadLb' | 'calculatedPayloadKg' | 'calculatedPayloadLb' | 'capacityLiters' | 'capacityCubicMeters' | 'capacityCubicFeet';
type OcrLine = { text: string; mean: number; box?: number[][] };

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
      this.status.set(`OCR complete. Found ${lines.length} text region${lines.length === 1 ? '' : 's'}. Review the fields before exporting.`);
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

  private async createOcrPasses(image: Blob, imageUrl: string): Promise<Array<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean }>> {
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
      return await Promise.all(passes.map(async (pass) => {
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
