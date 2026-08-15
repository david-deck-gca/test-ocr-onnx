import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the OCR workspace without panel headings', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.panel-heading')).toBeNull();
    expect(compiled.querySelector('input[type="file"]')?.getAttribute('capture')).toBeNull();
  });

  it('should render empty field values by default', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const inputs = Array.from(compiled.querySelectorAll<HTMLInputElement>('.field-grid input:not([type="radio"])'));
    expect(inputs.every((input) => input.value === '' && input.placeholder === '')).toBe(true);
  });

  it('should default to an editable full-image crop and quick processing', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      cropDraft: () => { x: number; y: number; width: number; height: number };
      processingMode: () => string;
    };

    expect(app.cropDraft()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(app.processingMode()).toBe('full-photo');
  });

  it('should default to manual crop and render both capture mode choices', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      captureMode: () => string;
    };
    fixture.detectChanges();

    const radios = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLInputElement>('input[name="capture-mode"]'));

    expect(app.captureMode()).toBe('manual-crop');
    expect(radios.map((radio) => radio.value)).toEqual(['manual-crop', 'auto-crop']);
    expect(radios[0].checked).toBe(true);
  });

  it('should not start automatic OCR when a manual-crop image is selected', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      captureMode: { set(value: string): void };
      prepareInitialCrop: ReturnType<typeof vi.fn>;
      useImage(image: Blob, name: string): void;
    };
    const createObjectUrl = vi.fn().mockReturnValue('blob:manual-crop');
    vi.stubGlobal('URL', { createObjectURL: createObjectUrl, revokeObjectURL: vi.fn() });
    app.captureMode.set('manual-crop');
    app.prepareInitialCrop = vi.fn();

    try {
      app.useImage(new Blob(['image'], { type: 'image/jpeg' }), 'container.jpg');

      expect(app.prepareInitialCrop).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('should clear OCR fields when choosing a new image', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      fields: { set(value: Record<string, { value: string }>): void; (): Record<string, { value: string }> };
      rawText: { set(value: string[]): void; (): string[] };
      rawScans: { set(value: Array<{ label: string; lines: Array<{ text: string; confidence: number }> }>): void; (): Array<{ label: string; lines: Array<{ text: string; confidence: number }> }> };
      openFilePicker(): void;
    };
    app.fields.set({ containerId: { value: 'HCSU7997909' } });
    app.rawText.set(['HCSU 799790 9 (98%)']);
    app.rawScans.set([{ label: 'Full photo', lines: [{ text: 'HCSU 799790 9', confidence: 98 }] }]);

    app.openFilePicker();

    expect(app.fields()['containerId'].value).toBe('');
    expect(app.rawText()).toEqual([]);
    expect(app.rawScans()).toEqual([]);
  });

  it('should render raw text grouped by OCR scan', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      rawScans: { set(value: Array<{ label: string; lines: Array<{ text: string; confidence: number }>; durationMs: number }>): void };
    };
    app.rawScans.set([
      { label: 'Selected region', lines: [{ text: 'HCSU 799790 9', confidence: 98 }], durationMs: 320 },
      { label: 'Selected region (2x)', lines: [{ text: 'TARE 3,650 KG', confidence: 94 }], durationMs: 480 },
    ]);
    fixture.detectChanges();

    const panel = (fixture.nativeElement as HTMLElement).querySelector('.raw-text')!;
    expect(panel.textContent).toContain('Selected region');
    expect(panel.textContent).toContain('320 ms');
    expect(panel.textContent).toContain('480 ms');
    expect(panel.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(panel.textContent).toContain('98%');
    expect(panel.textContent).not.toContain('(98%)');
  });

  it('should process the selected crop only after it is prepared', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      applyCrop(): Promise<boolean>;
      processImage(): Promise<void>;
      applyCropAndProcess(): Promise<void>;
    };
    app.applyCrop = vi.fn().mockResolvedValue(true);
    app.processImage = vi.fn().mockResolvedValue(undefined);

    await app.applyCropAndProcess();

    expect(app.applyCrop).toHaveBeenCalled();
    expect(app.processImage).toHaveBeenCalled();
  });

  it('should attach the camera stream after the video preview is rendered', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as { openCamera(): Promise<void> };
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const mediaDevices = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: vi.fn().mockResolvedValue(stream) } as unknown as MediaDevices,
    });

    try {
      await app.openCamera();
      fixture.detectChanges();
      await fixture.whenStable();

      expect((fixture.nativeElement as HTMLElement).querySelector<HTMLVideoElement>('video')?.srcObject).toBe(stream);
      expect(play).toHaveBeenCalled();
    } finally {
      play.mockRestore();
      if (mediaDevices) {
        Object.defineProperty(navigator, 'mediaDevices', mediaDevices);
      } else {
        delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
      }
    }
  });

  it('should resize a crop from its bottom-right handle', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      cropDraft: { set(value: { x: number; y: number; width: number; height: number }): void; (): { x: number; y: number; width: number; height: number } };
      resizeCrop(handle: string, crop: { x: number; y: number; width: number; height: number }, point: { x: number; y: number }): void;
    };
    const crop = { x: 0.2, y: 0.3, width: 0.3, height: 0.3 };
    app.cropDraft.set(crop);

    app.resizeCrop('bottom-right', crop, { x: 0.8, y: 0.9 });

    expect(app.cropDraft().x).toBe(0.2);
    expect(app.cropDraft().y).toBe(0.3);
    expect(app.cropDraft().width).toBeCloseTo(0.6);
    expect(app.cropDraft().height).toBeCloseTo(0.6);
  });

  it('should retain selected manual crop coordinates in exported data', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      cropRect: { set(value: { x: number; y: number; width: number; height: number }): void };
      createJsonPayload(): { source: { manualCrop: { x: number; y: number; width: number; height: number } | null } };
    };
    const crop = { x: 0.64, y: 0.22, width: 0.24, height: 0.12 };

    app.cropRect.set(crop);

    expect(app.createJsonPayload().source.manualCrop).toEqual(crop);
  });

  it('should keep the crop unselected when preview creation fails', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      cropDraft: { set(value: { x: number; y: number; width: number; height: number }): void };
      cropRect: () => { x: number; y: number; width: number; height: number } | null;
      diagnostics: () => Array<{ stage: string; message: string }>;
      updateCropPreview(crop: { x: number; y: number; width: number; height: number }): Promise<void>;
      applyCrop(): Promise<void>;
    };
    app.cropDraft.set({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 });
    app.updateCropPreview = () => Promise.reject(new Error('Canvas unavailable'));

    await app.applyCrop();

    expect(app.cropRect()).toBeNull();
    expect(app.diagnostics().some((diagnostic) => diagnostic.stage === 'Manual crop' && diagnostic.message === 'The selected region could not be prepared. Adjust the rectangle or choose the image again.')).toBe(true);
  });

  it('should use a loaded image element when bitmap and image decode fail', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      decodeImage(image: Blob): Promise<{ width: number; height: number; release(): void }>;
    };
    const createObjectUrl = vi.fn().mockReturnValue('blob:fallback-image');
    const revokeObjectUrl = vi.fn();
    const decode = vi.fn().mockRejectedValue(new Error('Image.decode is unsupported'));

    vi.stubGlobal('createImageBitmap', vi.fn().mockRejectedValue(new Error('WebP bitmap decoding failed')));
    vi.stubGlobal('URL', { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl });
    vi.stubGlobal('Image', class {
      naturalWidth = 768;
      naturalHeight = 768;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
      decode = decode;
    });

    try {
      const decoded = await app.decodeImage(new Blob(['image'], { type: 'image/webp' }));

      expect(decode).toHaveBeenCalled();
      expect(decoded.width).toBe(768);
      expect(decoded.height).toBe(768);
      decoded.release();
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:fallback-image');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('should cap manual crop output dimensions by pixel budget', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      cropOutputScale(sourceWidth: number, sourceHeight: number, requestedScale: number, maximumWidth?: number, maximumPixels?: number): number;
    };

    expect(app.cropOutputScale(4_000, 3_000, 1, undefined, 4_000_000)).toBeCloseTo(Math.sqrt(1 / 3));
    expect(app.cropOutputScale(2_000, 1_000, 2, undefined, 4_000_000)).toBeCloseTo(Math.sqrt(2));
  });

  it('should release every temporary OCR pass when pass preparation fails', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      releaseOcrPasses(passes: Array<{ url: string; revokeUrl: boolean }>): void;
    };
    const revokeObjectUrl = vi.fn();
    vi.stubGlobal('URL', { revokeObjectURL: revokeObjectUrl });

    try {
      app.releaseOcrPasses([
        { url: 'blob:first', revokeUrl: true },
        { url: 'blob:source', revokeUrl: false },
        { url: 'blob:second', revokeUrl: true },
      ]);

      expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:first');
      expect(revokeObjectUrl).toHaveBeenCalledWith('blob:second');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('should extract tank container weights without inventing a payload', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'LASU 210040 0', mean: 0.99 },
      { text: '22K2', mean: 0.98 },
      { text: 'MPGM', mean: 0.97 },
      { text: '36000KG', mean: 0.96 },
      { text: '79365LB', mean: 0.95 },
      { text: 'TARE', mean: 0.97 },
      { text: '3650KG', mean: 0.96 },
      { text: '8047LB', mean: 0.95 },
      { text: 'Capacity: 25,000 L', mean: 0.94 },
    ]);

    expect(fields['containerId'].value).toBe('LASU2100400');
    expect(fields['isoCode'].value).toBe('22K2');
    expect(fields['mpgmKg'].value).toBe('36000');
    expect(fields['mpgmLb'].value).toBe('79365');
    expect(fields['tareKg'].value).toBe('3650');
    expect(fields['tareLb'].value).toBe('8047');
    expect(fields['payloadKg'].value).toBe('');
    expect(fields['payloadLb'].value).toBe('');
    expect(fields['capacityLiters'].value).toBe('25,000');
  });

  it('should preserve a printed payload', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'MPGM 36000 KG', mean: 0.99 },
      { text: 'TARE 3650 KG', mean: 0.99 },
      { text: 'MAX PAYLOAD 32350 KG', mean: 0.99 },
    ]);

    expect(fields['payloadKg'].value).toBe('32350');
  });

  it('should preserve all detected capacity digits', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'CAPACITY 25.000L', mean: 0.99 },
    ]);

    expect(fields['capacityLiters'].value).toBe('25.000');
  });

  it('should prefer the highest-confidence capacity', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'CAPACITY 25,800 L', mean: 0.98 },
      { text: 'CAPACITY 25,000 L', mean: 0.91 },
    ]);

    expect(fields['capacityLiters'].value).toBe('25,800');
  });

  it('should recognize common OCR variants of payload and capacity labels', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'Payjload 32.350 KG', mean: 0.99 },
      { text: 'Capcity 25,000 L', mean: 0.99 },
    ]);

    expect(fields['payloadKg'].value).toBe('32.350');
    expect(fields['capacityLiters'].value).toBe('25,000');
  });

  it('should extract a payload when OCR joins its misspelled label to the value', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'Payjlad3.350KG', mean: 0.78 },
    ]);

    expect(fields['payloadKg'].value).toBe('3.350');
  });

  it('should associate each weight with its label when OCR combines payload and tare', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'Payjload3.350KG TARE:3.650KG', mean: 0.86 },
    ]);

    expect(fields['payloadKg'].value).toBe('3.350');
    expect(fields['tareKg'].value).toBe('3.650');
  });

  it('should preserve a payload returned several OCR lines after its label', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'MPGM 36.000 KG', mean: 0.99 },
      { text: 'TARE 3.650 KG', mean: 0.99 },
      { text: 'Payjlad', mean: 0.99 },
      { text: 'Container mark', mean: 0.9 },
      { text: 'Container mark', mean: 0.9 },
      { text: 'Container mark', mean: 0.9 },
      { text: 'Container mark', mean: 0.9 },
      { text: '32.350 KG', mean: 0.99 },
    ]);

    expect(fields['payloadKg'].value).toBe('32.350');
  });

  it('should select the TARE value closest to its label', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number; box?: number[][] }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'TARE', mean: 0.9, box: [[0, 100], [40, 100], [40, 120], [0, 120]] },
      { text: '79365 LB', mean: 0.8, box: [[100, 80], [180, 80], [180, 100], [100, 100]] },
      { text: '8047 LB', mean: 0.99, box: [[100, 120], [180, 120], [180, 140], [100, 140]] },
    ]);

    expect(fields['tareLb'].value).toBe('8047');
  });

  it('should cautiously recover missing tare and net rows after a detected gross-weight row', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string; inferred?: boolean }>;
    };

    const fields = app.extractFields([
      { text: 'MAX.GR. 3.000 KG 6.610 LB', mean: 0.99 },
      { text: '670 KG 1.477 LB', mean: 0.92 },
      { text: '2.330 KG 5.133 LB', mean: 0.91 },
    ]);

    expect(fields['tareKg'].value).toBe('670');
    expect(fields['tareLb'].value).toBe('1.477');
    expect(fields['tareKg'].inferred).toBe(true);
    expect(fields['payloadKg'].value).toBe('2.330');
    expect(fields['payloadLb'].value).toBe('5.133');
    expect(fields['payloadKg'].inferred).toBe(true);
  });

  it('should extract standard general-purpose container markings', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    const fields = app.extractFields([
      { text: 'MAX.GR. 3.000 KGS 6.610 LBS', mean: 0.99 },
      { text: 'TARE 560 KGS 1.230 LBS', mean: 0.99 },
      { text: 'NET 2.440 KGS 5.380 LBS', mean: 0.99 },
      { text: 'CU.CAP. 4.6 CU.M. 162 CU.FT.', mean: 0.99 },
    ]);

    expect(fields['mpgmKg'].value).toBe('3.000');
    expect(fields['mpgmLb'].value).toBe('6.610');
    expect(fields['payloadKg'].value).toBe('2.440');
    expect(fields['payloadLb'].value).toBe('5.380');
    expect(fields['capacityCubicMeters'].value).toBe('4.6');
    expect(fields['capacityCubicFeet'].value).toBe('162');
  });

  it('should recover a checksum-valid container ID split across OCR regions', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number; box?: number[][] }>): Record<string, { value: string; confidence?: number }>;
    };

    const fields = app.extractFields([
      { text: 'HCSU 799790', mean: 0.92, box: [[20, 40], [170, 40], [170, 60], [20, 60]] },
      { text: '9', mean: 0.88, box: [[180, 40], [190, 40], [190, 60], [180, 60]] },
    ]);

    expect(fields['containerId'].value).toBe('HCSU7997909');
    expect(fields['containerId'].confidence).toBe(0.88);
  });

  it('should propose a crop around the container ID and aligned text below it', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      suggestedMarkingBounds(lines: Array<{ text: string; mean: number; box?: number[][] }>, containerId: string): { left: number; top: number; right: number; bottom: number } | null;
    };
    const lines = [
      { text: 'HCSU 799790', mean: 0.92, box: [[400, 100], [560, 100], [560, 125], [400, 125]] },
      { text: '9', mean: 0.88, box: [[570, 100], [580, 100], [580, 125], [570, 125]] },
      { text: 'MAX.GR. 30,480 KG', mean: 0.95, box: [[380, 150], [620, 150], [620, 175], [380, 175]] },
      { text: 'TARE 3,780 KG', mean: 0.95, box: [[380, 185], [580, 185], [580, 210], [380, 210]] },
    ];

    const bounds = app.suggestedMarkingBounds(lines, 'HCSU7997909');

    expect(bounds).toEqual({ left: 380, top: 100, right: 620, bottom: 210 });
  });

  it('should propose a crop from an ID stem when the check digit is missing', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      suggestedMarkingBounds(lines: Array<{ text: string; mean: number; box?: number[][] }>, containerId: string): { left: number; top: number; right: number; bottom: number } | null;
    };
    const lines = [
      { text: 'HCSU 799790', mean: 0.92, box: [[400, 100], [560, 100], [560, 125], [400, 125]] },
      { text: 'MAX.GR. 30,480 KG', mean: 0.95, box: [[380, 150], [620, 150], [620, 175], [380, 175]] },
      { text: 'TARE 3,780 KG', mean: 0.95, box: [[380, 185], [580, 185], [580, 210], [380, 210]] },
    ];

    expect(app.suggestedMarkingBounds(lines, '')).toEqual({ left: 380, top: 100, right: 636, bottom: 210 });
  });

  it('should propose a crop from an ID stem split across OCR regions', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      suggestedMarkingBounds(lines: Array<{ text: string; mean: number; box?: number[][] }>, containerId: string): { left: number; top: number; right: number; bottom: number } | null;
    };
    const lines = [
      { text: 'HCSU', mean: 0.92, box: [[400, 100], [445, 100], [445, 125], [400, 125]] },
      { text: '799790', mean: 0.9, box: [[450, 100], [560, 100], [560, 125], [450, 125]] },
      { text: 'MAX.GR. 30,480 KG', mean: 0.95, box: [[380, 150], [620, 150], [620, 175], [380, 175]] },
    ];

    expect(app.suggestedMarkingBounds(lines, '')).toEqual({ left: 380, top: 100, right: 636, bottom: 175 });
  });

  it('should not populate an ID with an invalid check digit', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string }>;
    };

    expect(app.extractFields([{ text: 'HCSU 799790 8', mean: 0.95 }])['containerId'].value).toBe('');
  });

  it('should replace the full-image draft with an ID-focused crop after initial detection', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      imageSelection: number;
      cropDraft: () => { x: number; y: number; width: number; height: number };
      automaticCropSuggested: () => boolean;
      status: () => string;
      getOcr(): Promise<{ detect(url: string): Promise<Array<{ text: string; mean: number; box: number[][] }>> }>;
      createCropPass(): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean }>;
      createSuggestedCrop(lines: Array<{ text: string; mean: number; box: number[][] }>, containerId: string, image: Blob): Promise<{ x: number; y: number; width: number; height: number } | null>;
      prepareInitialCrop(image: Blob, selection: number): Promise<void>;
    };
    const focusedCrop = { x: 0.3, y: 0.2, width: 0.4, height: 0.35 };
    app.imageSelection = 1;
    app.getOcr = async () => ({
      detect: async () => [{ text: 'HCSU 799790 9', mean: 0.95, box: [[300, 100], [500, 100], [500, 130], [300, 130]] }],
    });
    app.createCropPass = async () => ({ url: 'blob:full-photo', offsetX: 0, offsetY: 0, scale: 1, revokeUrl: true });
    app.createSuggestedCrop = async () => focusedCrop;

    await app.prepareInitialCrop(new Blob(), 1);

    expect(app.cropDraft()).toEqual(focusedCrop);
    expect(app.automaticCropSuggested()).toBe(true);
    expect(app.status()).toMatch(/markings below\. \(\d+ ms\)$/);
  });

});
