import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const source = join(process.cwd(), 'models', 'source');
const output = join(process.cwd(), 'public', 'models');
mkdirSync(output, { recursive: true });

if (!existsSync(source)) {
  throw new Error('Source models are missing. Run "npm run models:download" first.');
}

throw new Error([
  'PaddleOCR source archives were downloaded, but ONNX conversion has not been automated yet.',
  'Extract each archive and use the official paddle2onnx converter against its inference model.',
  'Place verified outputs at public/models/ppocr-det.onnx and public/models/en-ppocrv5-rec.onnx.',
  'Record model input/output names and shapes before enabling the OCR worker pipeline.',
].join(' '));
