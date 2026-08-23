import { TestBed } from '@angular/core/testing';
import Ocr from '@gutenye/ocr-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OcrService } from './ocr.service';

vi.mock('@gutenye/ocr-browser', () => ({
  default: { create: vi.fn() },
}));

describe('OcrService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [OcrService] });
    vi.mocked(Ocr.create).mockReset();
  });

  it('should share one OCR initialization across concurrent callers', async () => {
    const service = TestBed.inject(OcrService);
    const engine = { detect: vi.fn() };
    vi.mocked(Ocr.create).mockResolvedValue(engine as never);

    await Promise.all([service.initialize(), service.initialize()]);

    expect(Ocr.create).toHaveBeenCalledTimes(1);
  });

  it('should retain an initialization failure without creating replacement sessions', async () => {
    const service = TestBed.inject(OcrService);
    vi.mocked(Ocr.create).mockRejectedValue(new Error('Model allocation failed'));

    await service.initialize();

    expect(service.initializationError()).toBe('Model allocation failed');
    await expect(service.detect('blob:crop')).rejects.toThrow('Model allocation failed');
    expect(Ocr.create).toHaveBeenCalledTimes(1);
  });
});
