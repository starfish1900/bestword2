import { brotliCompress, constants, gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
let originals = 0; let brBytes = 0; let gzBytes = 0; let count = 0;
async function compress(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await compress(path);
    else if (entry.isFile() && /\.(?:js|css|html)$/.test(entry.name)) {
      const source = await readFile(path);
      const [br, zipped] = await Promise.all([
        brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        gz(source, { level: 9 }),
      ]);
      await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, zipped)]);
      originals += source.length; brBytes += br.length; gzBytes += zipped.length; count++;
    }
  }
}
await compress(dist);
console.log(`Precompressed ${count} files: ${originals} bytes original, ${brBytes} Brotli, ${gzBytes} gzip.`);
