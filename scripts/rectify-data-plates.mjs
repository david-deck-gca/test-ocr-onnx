import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { chromium } from '@playwright/test';

const root = process.cwd();
const outputDirectory = path.join(root, 'test-results', 'data-plate-rectification');
const opencvPath = path.join(root, 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv-browser.js');
const fixturePath = path.join(root, 'scripts', 'data-plate-rectification-fixtures.json');
const fixtures = JSON.parse(await readFile(fixturePath, 'utf8')).plates;

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="work"></canvas>');
await page.addScriptTag({ path: opencvPath });
await page.waitForFunction(() => Boolean(globalThis.cv?.Mat));

const results = [];
try {
  for (const fixture of fixtures) {
    const name = path.basename(fixture.source, path.extname(fixture.source));
    const destination = path.join(outputDirectory, name);
    await mkdir(destination, { recursive: true });

    const readStarted = performance.now();
    const image = await readFile(path.join(root, fixture.source));
    const readMs = performance.now() - readStarted;
    const result = await page.evaluate(async ({ bytes, corners }) => {
      const timings = {};
      const timed = async (name, work) => {
        const started = performance.now();
        const value = await work();
        timings[name] = performance.now() - started;
        return value;
      };
      const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
      const workCanvas = document.querySelector('#work');
      let source;
      try {
        const decoded = await timed('decode', async () => {
          const image = new Image();
          image.src = url;
          await image.decode();
          return image;
        });
        await timed('validate fixture corners', () => validateCorners(corners, decoded.naturalWidth, decoded.naturalHeight));
        const rectified = await timed('perspective warp', () => {
          workCanvas.width = decoded.naturalWidth;
          workCanvas.height = decoded.naturalHeight;
          workCanvas.getContext('2d').drawImage(decoded, 0, 0);
          source = cv.imread(workCanvas);
          const width = Math.round(Math.max(distance(corners[0], corners[1]), distance(corners[2], corners[3])));
          const height = Math.round(Math.max(distance(corners[0], corners[3]), distance(corners[1], corners[2])));
          const input = cv.matFromArray(4, 1, cv.CV_32FC2, corners.flat());
          const output = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, width - 1, 0, width - 1, height - 1, 0, height - 1]);
          const transform = cv.getPerspectiveTransform(input, output);
          const warped = new cv.Mat();
          const outputCanvas = document.createElement('canvas');
          outputCanvas.width = width;
          outputCanvas.height = height;
          try {
            cv.warpPerspective(source, warped, transform, new cv.Size(width, height), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
            cv.imshow(outputCanvas, warped);
            return { width, height, canvas: outputCanvas };
          } finally {
            input.delete();
            output.delete();
            transform.delete();
            warped.delete();
          }
        });
        const images = await timed('JPEG encoding', async () => {
          const diagnosticCanvas = document.createElement('canvas');
          diagnosticCanvas.width = decoded.naturalWidth;
          diagnosticCanvas.height = decoded.naturalHeight;
          const context = diagnosticCanvas.getContext('2d');
          context.drawImage(decoded, 0, 0);
          context.strokeStyle = '#00ff66';
          context.lineWidth = Math.max(4, decoded.naturalWidth / 400);
          context.beginPath();
          corners.forEach(([x, y], index) => index ? context.lineTo(x, y) : context.moveTo(x, y));
          context.closePath();
          context.stroke();
          return {
            diagnostic: diagnosticCanvas.toDataURL('image/jpeg', 0.94),
            rectified: rectified.canvas.toDataURL('image/jpeg', 0.94),
          };
        });
        return {
          source: { width: decoded.naturalWidth, height: decoded.naturalHeight },
          corners,
          output: { width: rectified.width, height: rectified.height },
          timings,
          images,
        };
      } finally {
        URL.revokeObjectURL(url);
        source?.delete();
        workCanvas.width = 0;
        workCanvas.height = 0;
      }

      function validateCorners(points, width, height) {
        if (!Array.isArray(points) || points.length !== 4) throw new Error('Each fixture must define four corners.');
        if (points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height)) {
          throw new Error('Fixture corners must be within the source image.');
        }
        const area = Math.abs(points.reduce((sum, point, index) => {
          const next = points[(index + 1) % points.length];
          return sum + point[0] * next[1] - next[0] * point[1];
        }, 0) / 2);
        if (area < width * height * 0.05) throw new Error('Fixture quadrilateral is too small to be a data plate.');
      }

      function distance([x1, y1], [x2, y2]) {
        return Math.hypot(x2 - x1, y2 - y1);
      }
    }, { bytes: [...image], corners: fixture.corners });

    const writeStarted = performance.now();
    await Promise.all([
      writeDataUrl(result.images.diagnostic, path.join(destination, 'detected-corners.jpg')),
      writeDataUrl(result.images.rectified, path.join(destination, 'rectified.jpg')),
      writeFile(path.join(destination, 'metadata.json'), `${JSON.stringify({ ...result, images: undefined }, null, 2)}\n`, 'utf8'),
    ]);
    const writeMs = performance.now() - writeStarted;
    results.push({ fixture, name, readMs, writeMs, ...result });
  }
} finally {
  await browser.close();
}

await writeFile(path.join(outputDirectory, 'timings.md'), formatReport(results), 'utf8');

async function writeDataUrl(dataUrl, destination) {
  const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
  if (base64 === dataUrl) throw new Error('Generated image was not JPEG data.');
  await writeFile(destination, Buffer.from(base64, 'base64'));
}

function formatReport(entries) {
  const lines = [
    '# Data Plate Perspective Rectification',
    '',
    'The test uses manually verified plate corners and a four-point projective homography (`cv.getPerspectiveTransform` + `cv.warpPerspective`). A homography is the correct transform for a flat rectangular plate photographed at an angle: it corrects roll and the converging edges caused by perspective.',
    '',
    'For automatic corner detection in production, use metallic-color segmentation to propose a region, then combine Canny edges, contours, and Hough lines to score a convex four-corner candidate. Keep these verified fixtures as the regression oracle; unvalidated edge lines can otherwise select the surrounding tank frame.',
    '',
  ];
  for (const entry of entries) {
    const browserTotal = Object.values(entry.timings).reduce((sum, duration) => sum + duration, 0);
    lines.push(`## ${entry.name}`, '');
    lines.push(`- Source: \`${entry.fixture.source}\` (${entry.source.width}x${entry.source.height})`);
    lines.push(`- Corner source: manually verified regression fixture`);
    lines.push(`- Detected corners (top-left, top-right, bottom-right, bottom-left): ${entry.corners.map(([x, y]) => `(${x.toFixed(1)}, ${y.toFixed(1)})`).join(', ')}`);
    lines.push(`- Rectified output: ${entry.output.width}x${entry.output.height}`);
    lines.push('', '| Process | Duration (ms) |', '| --- | ---: |');
    lines.push(`| Read input | ${entry.readMs.toFixed(2)} |`);
    for (const [name, duration] of Object.entries(entry.timings)) lines.push(`| ${name} | ${duration.toFixed(2)} |`);
    lines.push(`| Write artifacts | ${entry.writeMs.toFixed(2)} |`);
    lines.push(`| Browser processing total | ${browserTotal.toFixed(2)} |`, '');
  }
  return `${lines.join('\n')}\n`;
}
