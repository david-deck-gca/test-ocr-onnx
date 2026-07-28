import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const modulePath = join(process.cwd(), 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv.js');
const browserPath = join(process.cwd(), 'node_modules', '@techstark', 'opencv-js', 'dist', 'opencv-browser.js');

// OpenCV is served as a local browser script from index.html. The package's default
// CommonJS entry also attempts Node-only fs/path imports, which Angular cannot bundle.
const source = await readFile(modulePath, 'utf8');
if (!source.includes('globalThis.cv')) {
  await writeFile(browserPath, source);
}
await writeFile(modulePath, 'module.exports = globalThis.cv;\n');
