import { Injectable, signal } from '@angular/core';
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

@Injectable({ providedIn: 'root' })
export class OcrService {
  readonly initializationError = signal<string | null>(null);

  private ocr: Awaited<ReturnType<typeof Ocr.create>> | null = null;
  private initialization: Promise<void> | null = null;

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.createOcr();
    }
    return this.initialization;
  }

  async detect(url: string) {
    await this.initialize();
    if (!this.ocr) {
      throw new Error(this.initializationError() ?? 'Local OCR could not be initialized.');
    }
    return this.ocr.detect(url);
  }

  private async createOcr(): Promise<void> {
    this.initializationError.set(null);
    ort.env.wasm.wasmPaths = new URL('ort/', document.baseURI).toString();
    // One worker avoids allocating multiple large WASM heaps on memory-constrained mobile devices.
    ort.env.wasm.numThreads = 1;

    try {
      this.ocr = await Ocr.create({
        models: {
          detectionPath: new URL('models/ch_PP-OCRv4_det_infer.onnx', document.baseURI).toString(),
          recognitionPath: new URL('models/ch_PP-OCRv4_rec_infer.onnx', document.baseURI).toString(),
          dictionaryPath: new URL('models/ppocr_keys_v1.txt', document.baseURI).toString(),
        },
      });
    } catch (error: unknown) {
      this.initializationError.set(error instanceof Error ? error.message : String(error));
    }
  }
}
