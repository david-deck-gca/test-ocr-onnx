import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';

const directory = join(process.cwd(), 'models', 'source');
mkdirSync(directory, { recursive: true });

const models = [
  ['ppocr-v5-mobile-det.tar', 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_infer.tar'],
  ['en-ppocr-v5-mobile-rec.tar', 'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/en_PP-OCRv5_mobile_rec_infer.tar'],
];

for (const [fileName, url] of models) {
  const target = join(directory, fileName);
  if (existsSync(target)) {
    console.log(`Already downloaded: ${fileName}`);
    continue;
  }
  console.log(`Downloading ${fileName}...`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
}

console.log('Downloaded PaddleOCR source models. Run "npm run models:convert" to produce the ONNX assets.');
