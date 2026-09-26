/**
 * Packages the Claude desktop app plugin (plugins/firefinder-desktop) as
 * dist/firefinder.plugin, the zip file the app installs. The evals stay out:
 * they test the plugin but aren't part of it. Written without a zip tool so it
 * runs the same on Windows, macOS and Linux.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const SOURCE = 'plugins/firefinder-desktop';
const OUTPUT = 'dist/firefinder.plugin';

// Every entry is dated 1980-01-01, so the same files always make the same package.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;

function listFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const names = listFiles(SOURCE)
  .map((path) => relative(SOURCE, path).split(sep).join('/'))
  .filter((name) => !name.startsWith('evals/'))
  .sort();

const entries: Buffer[] = [];
const directory: Buffer[] = [];
let offset = 0;

for (const name of names) {
  const data = readFileSync(join(SOURCE, name));
  const compressed = deflateRawSync(data);
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(UTF8_NAMES, 6);
  local.writeUInt16LE(DEFLATE, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  entries.push(local, nameBytes, compressed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(UTF8_NAMES, 8);
  central.writeUInt16LE(DEFLATE, 10);
  central.writeUInt16LE(DOS_TIME, 12);
  central.writeUInt16LE(DOS_DATE, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(offset, 42);
  directory.push(central, nameBytes);

  offset += local.length + nameBytes.length + compressed.length;
}

const directorySize = directory.reduce((size, part) => size + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(names.length, 8);
end.writeUInt16LE(names.length, 10);
end.writeUInt32LE(directorySize, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, Buffer.concat([...entries, ...directory, end]));
console.log(`wrote ${OUTPUT} (${names.length} files)`);
for (const name of names) console.log(`  ${name}`);
