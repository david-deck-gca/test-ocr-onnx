import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const root = process.cwd();
const sources = [
  'images/data-plate_vertical_cropped.jpg',
  'images/nt-tank_cropped.jpg',
];
const opencvPath = path.join(root, 'node_modules/@techstark/opencv-js/dist/opencv-browser.js');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="work"></canvas>');
await page.addScriptTag({ path: opencvPath });
await page.waitForFunction(() => Boolean(globalThis.cv?.Mat));

for (const source of sources) {
  const input = path.join(root, source);
  const outputDirectory = path.join(root, 'images', path.basename(source, path.extname(source)));
  await fs.rm(outputDirectory, { recursive: true, force: true });
  await fs.mkdir(outputDirectory, { recursive: true });
  const image = await fs.readFile(input);
  const result = await page.evaluate(async ({ bytes }) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();

      const canvas = document.querySelector('#work');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext('2d').drawImage(image, 0, 0);

      const sourceMat = cv.imread(canvas);
      const gray = new cv.Mat();
      const edges = new cv.Mat();
      cv.cvtColor(sourceMat, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
      cv.Canny(gray, edges, 35, 110);

      const horizontalLines = detectLines(edges, true, image.naturalWidth, image.naturalHeight);
      const verticalLines = detectLines(edges, false, image.naturalWidth, image.naturalHeight);
      const xCuts = clusterCuts(verticalLines.map((line) => line.position), image.naturalWidth);
      const yCuts = clusterCuts(horizontalLines.map((line) => line.position), image.naturalHeight);
      const xBounds = [0, ...xCuts, image.naturalWidth];
      const yBounds = [0, ...yCuts, image.naturalHeight];
      const crops = [];

      for (let row = 0; row < yBounds.length - 1; row++) {
        for (let column = 0; column < xBounds.length - 1; column++) {
          const left = xBounds[column] + (column > 0 ? 5 : 0);
          const top = yBounds[row] + (row > 0 ? 5 : 0);
          const right = xBounds[column + 1] - (column < xBounds.length - 2 ? 5 : 0);
          const bottom = yBounds[row + 1] - (row < yBounds.length - 2 ? 5 : 0);
          if (right - left < image.naturalWidth * 0.08 || bottom - top < image.naturalHeight * 0.08) continue;
          const tile = document.createElement('canvas');
          tile.width = right - left;
          tile.height = bottom - top;
          tile.getContext('2d').drawImage(image, left, top, tile.width, tile.height, 0, 0, tile.width, tile.height);
          const dataUrl = tile.toDataURL('image/jpeg', 0.94);
          crops.push({ row, column, width: tile.width, height: tile.height, dataUrl });
        }
      }

      sourceMat.delete();
      gray.delete();
      edges.delete();
      return { width: image.naturalWidth, height: image.naturalHeight, xCuts, yCuts, crops };

      function detectLines(mat, horizontalDirection, width, height) {
        const detected = new cv.Mat();
        cv.HoughLinesP(mat, detected, 1, Math.PI / 180, 45, Math.min(width, height) * 0.18, 24);
        const lines = [];
        const minimumSpan = (horizontalDirection ? width : height) * 0.28;
        for (let index = 0; index < detected.rows; index++) {
          const x1 = detected.intAt(index, 0);
          const y1 = detected.intAt(index, 1);
          const x2 = detected.intAt(index, 2);
          const y2 = detected.intAt(index, 3);
          const span = Math.hypot(x2 - x1, y2 - y1);
          const angle = Math.atan2(Math.abs(y2 - y1), Math.abs(x2 - x1));
          const isHorizontal = angle < Math.PI / 36;
          const isVertical = Math.abs(angle - Math.PI / 2) < Math.PI / 36;
          if (span < minimumSpan || (horizontalDirection ? !isHorizontal : !isVertical)) continue;
          lines.push({ position: horizontalDirection ? (y1 + y2) / 2 : (x1 + x2) / 2, span });
        }
        detected.delete();
        return lines;
      }

      function clusterCuts(positions, size) {
        return positions
          .filter((position) => position > size * 0.08 && position < size * 0.9)
          .sort((a, b) => a - b)
          .reduce((clusters, position) => {
            const last = clusters.at(-1);
            if (last && position - last.at(-1) < size * 0.025) last.push(position);
            else clusters.push([position]);
            return clusters;
          }, [])
          .map((cluster) => Math.round(cluster.reduce((sum, position) => sum + position, 0) / cluster.length));
      }
    } finally {
      URL.revokeObjectURL(url);
    }
  }, { bytes: [...image] });

  await Promise.all(result.crops.map(async (crop, index) => {
    const base64 = crop.dataUrl.replace(/^data:image\/jpeg;base64,/, '');
    const name = `${String(index + 1).padStart(2, '0')}_r${crop.row + 1}_c${crop.column + 1}.jpg`;
    await fs.writeFile(path.join(outputDirectory, name), Buffer.from(base64, 'base64'));
  }));
  console.log(`${source}: ${result.width}x${result.height}, vertical cuts=${result.xCuts.join(',') || 'none'}, horizontal cuts=${result.yCuts.join(',') || 'none'}, panels=${result.crops.length}`);
}

await browser.close();
