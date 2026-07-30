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
    expect(compiled.querySelector('h1')?.textContent).toContain('Read the marks');
  });

  it('should render empty field values by default', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    const inputs = Array.from(compiled.querySelectorAll<HTMLInputElement>('.field-grid input'));
    expect(inputs.every((input) => input.value === '' && input.placeholder === '')).toBe(true);
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
    expect(fields['capacityCubicMeters'].value).toBe('4.6');
    expect(fields['capacityCubicFeet'].value).toBe('162');
  });

});
