import { Injectable, signal } from '@angular/core';
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

export type ExecutionProvider = 'wasm' | 'webgl' | 'webgpu';
export type OcrResultLine = { text: string; mean: number; box?: number[][] };
export type ProviderCapability = { provider: ExecutionProvider; available: boolean; reason?: string };

@Injectable({ providedIn: 'root' })
export class OcrService {
  readonly initializationError = signal<string | null>(null);
  readonly providerCapabilities = signal<ProviderCapability[]>([{ provider: 'wasm', available: true }]);

  private readonly ocrByProvider = new Map<ExecutionProvider, Awaited<ReturnType<typeof Ocr.create>>>();
  private readonly initializationByProvider = new Map<ExecutionProvider, Promise<void>>();
  private readonly providerErrors = new Map<ExecutionProvider, string>();
  initialize(provider: ExecutionProvider = 'wasm'): Promise<void> {
    let initialization = this.initializationByProvider.get(provider);
    if (!initialization) {
      initialization = this.createOcr(provider);
      this.initializationByProvider.set(provider, initialization);
    }
    return initialization;
  }

  async detect(url: string, provider: ExecutionProvider = 'wasm'): Promise<OcrResultLine[]> {
    await this.initialize(provider);
    const ocr = this.ocrByProvider.get(provider);
    if (!ocr) {
      throw new Error(this.providerErrors.get(provider) ?? 'Local OCR could not be initialized.');
    }
    return ocr.detect(url) as Promise<OcrResultLine[]>;
  }

  async detectProviderCapabilities(): Promise<ProviderCapability[]> {
    const capabilities: ProviderCapability[] = [{ provider: 'wasm', available: true }];
    const canvas = document.createElement('canvas');
    const webgl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    capabilities.push(webgl
      ? { provider: 'webgl', available: true }
      : { provider: 'webgl', available: false, reason: 'WebGL is not available in this browser.' });

    let webgpuAvailable = false;
    let webgpuReason = 'WebGPU is not available in this browser.';
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      webgpuAvailable = adapter !== null && adapter !== undefined;
      if (!webgpuAvailable) webgpuReason = 'No compatible WebGPU adapter was found.';
    } catch (error: unknown) {
      webgpuReason = error instanceof Error ? error.message : String(error);
    }
    capabilities.push({ provider: 'webgpu', available: webgpuAvailable, ...(webgpuAvailable ? {} : { reason: webgpuReason }) });
    this.providerCapabilities.set(capabilities);
    return capabilities;
  }

  providerError(provider: ExecutionProvider): string | null {
    return this.providerErrors.get(provider) ?? null;
  }

  private async createOcr(provider: ExecutionProvider): Promise<void> {
    this.initializationError.set(null);
    ort.env.wasm.wasmPaths = new URL('ort/', document.baseURI).toString();
    // One worker avoids allocating multiple large WASM heaps on memory-constrained mobile devices.
    ort.env.wasm.numThreads = 1;

    try {
      const ocr = await Ocr.create({
        models: {
          detectionPath: new URL('models/ch_PP-OCRv4_det_infer.onnx', document.baseURI).toString(),
          recognitionPath: new URL('models/ch_PP-OCRv4_rec_infer.onnx', document.baseURI).toString(),
          dictionaryPath: new URL('models/ppocr_keys_v1.txt', document.baseURI).toString(),
        },
        onnxOptions: { executionProviders: [provider] },
      });
      this.ocrByProvider.set(provider, ocr);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.providerErrors.set(provider, message);
      if (provider === 'wasm') this.initializationError.set(message);
    }
  }
}
