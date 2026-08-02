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

  it('should render the OCR workspace', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.capture-panel')).not.toBeNull();
    expect(compiled.querySelector('.empty-preview')?.textContent).toContain('Container photo');
    expect(compiled.querySelector('input[type="file"]')?.getAttribute('capture')).toBeNull();
  });

  it('should render empty field values by default', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const inputs = Array.from(compiled.querySelectorAll<HTMLInputElement>('.field-grid input:not([type="radio"])'));
    expect(inputs.every((input) => input.value === '' && input.placeholder === '')).toBe(true);
  });

  it('should default to an editable full-image crop', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      cropDraft: () => { x: number; y: number; width: number; height: number };
    };

    expect(app.cropDraft()).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it('should clear OCR fields when choosing a new image', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      fields: { set(value: Record<string, { value: string }>): void; (): Record<string, { value: string }> };
      rawText: { set(value: string[]): void; (): string[] };
      openFilePicker(): void;
    };
    app.fields.set({ containerId: { value: 'HCSU7997909' } });
    app.rawText.set(['HCSU 799790 9 (98%)']);

    app.openFilePicker();

    expect(app.fields()['containerId'].value).toBe('');
    expect(app.rawText()).toEqual([]);
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

  it('should scan the selected crop when requested', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      cropDraft: { set(value: { x: number; y: number; width: number; height: number }): void };
      cropRect: () => { x: number; y: number; width: number; height: number } | null;
      processImage(): Promise<void>;
      applyCrop(): Promise<void>;
    };
    app.cropDraft.set({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 });
    const processImage = vi.fn().mockResolvedValue(undefined);
    app.processImage = processImage;

    await app.applyCrop();

    expect(app.cropRect()).toEqual({ x: 0.2, y: 0.2, width: 0.3, height: 0.3 });
    expect(processImage).toHaveBeenCalledOnce();
  });

  it('should extract tank container weights without inventing a payload', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string; calculated?: boolean }>;
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
    expect(fields['calculatedPayloadKg'].value).toBe('');
    expect(fields['calculatedPayloadLb'].value).toBe('');
    expect(fields['payloadKg'].calculated).toBeUndefined();
    expect(fields['capacityLiters'].value).toBe('25,000');
  });

  it('should preserve a printed payload instead of labeling it calculated', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string; calculated?: boolean }>;
    };

    const fields = app.extractFields([
      { text: 'MPGM 36000 KG', mean: 0.99 },
      { text: 'TARE 3650 KG', mean: 0.99 },
      { text: 'MAX PAYLOAD 32350 KG', mean: 0.99 },
    ]);

    expect(fields['payloadKg'].value).toBe('32350');
    expect(fields['payloadKg'].calculated).toBe(false);
    expect(fields['calculatedPayloadKg'].value).toBe('32.350');
    expect(fields['calculatedPayloadKg'].calculated).toBe(true);
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
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string; calculated?: boolean }>;
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
    expect(fields['payloadKg'].calculated).toBe(false);
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
      extractFields(lines: Array<{ text: string; mean: number }>): Record<string, { value: string; calculated?: boolean }>;
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
    expect(fields['payloadKg'].calculated).toBe(false);
    expect(fields['calculatedPayloadKg'].value).toBe('2.440');
    expect(fields['calculatedPayloadLb'].value).toBe('5.380');
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

  it('should limit OCR input by its longest crop dimension', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      ocrOutputScale(sourceWidth: number, sourceHeight: number, scale: number, maximumDimension?: number): number;
    };

    expect(app.ocrOutputScale(4000, 3000, 1, 1600)).toBe(0.4);
    expect(app.ocrOutputScale(900, 4500, 1, 1600)).toBeCloseTo(1600 / 4500);
    expect(app.ocrOutputScale(1200, 800, 1, 1600)).toBe(1);
  });

  it('should replace the full-image draft with an ID-focused crop after initial detection', async () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      imageSelection: number;
      cropDraft: () => { x: number; y: number; width: number; height: number };
      fields: () => Record<string, { value: string }>;
      rawText: () => string[];
      getOcr(): Promise<{ detect(url: string): Promise<Array<{ text: string; mean: number; box: number[][] }>> }>;
       createSuggestedCrop(lines: Array<{ text: string; mean: number; box: number[][] }>, containerId: string, imageWidth: number, imageHeight: number): { x: number; y: number; width: number; height: number } | null;
       createCropPass(image: Blob, crop: { x: number; y: number; width: number; height: number }, scale: number, maximumDimension?: number): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean; sourceWidth: number; sourceHeight: number }>;
       prepareInitialCrop(image: Blob, selection: number): Promise<void>;
    };
    const focusedCrop = { x: 0.3, y: 0.2, width: 0.4, height: 0.35 };
    app.imageSelection = 1;
    app.getOcr = async () => ({
      detect: async () => [{ text: 'HCSU 799790 9', mean: 0.95, box: [[300, 100], [500, 100], [500, 130], [300, 130]] }],
    });
    app.createCropPass = async () => ({ url: 'blob:test', offsetX: 0, offsetY: 0, scale: 1, revokeUrl: true, sourceWidth: 1000, sourceHeight: 500 });
    app.createSuggestedCrop = () => focusedCrop;

    await app.prepareInitialCrop(new Blob(), 1);

    expect(app.cropDraft()).toEqual(focusedCrop);
    expect(app.fields()['containerId'].value).toBe('HCSU7997909');
    expect(app.rawText()).toEqual(['HCSU 799790 9 (95%)']);
  });

  it('should warn when a detected payload differs from the calculated value', () => {
    const fixture = TestBed.createComponent(App);
    const app = fixture.componentInstance as unknown as {
      updateField(key: 'mpgmKg' | 'tareKg' | 'payloadKg', value: string): void;
      payloadKgMismatch: () => boolean;
      fields: () => Record<string, { value: string }>;
    };

    app.updateField('mpgmKg', '34.000');
    app.updateField('tareKg', '3.650');
    app.updateField('payloadKg', '30300');

    expect(app.fields()['calculatedPayloadKg'].value).toBe('30.350');
    expect(app.payloadKgMismatch()).toBe(true);
  });

});
