import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config as loadEnvironment } from 'dotenv';
import { loadPersonalImport } from '../services/personalImport/PersonalImportLoadService';
import { buildPersonalImportPreview } from '../services/personalImport/PersonalImportService';
import type { PersonalImportManifest } from '../services/personalImport/types';

loadEnvironment({ path: path.resolve(__dirname, '../../.env') });

const getArgument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = async () => {
  if (!process.argv.includes('--confirm-load')) {
    throw new Error('Refusing to write without --confirm-load');
  }

  const manifestPath = getArgument('--manifest');
  if (!manifestPath) {
    throw new Error(
      'Usage: pnpm load:personal-import -- --manifest <path> --confirm-load'
    );
  }
  const uri = process.env.PERSONAL_MONGODB_URI;
  if (!uri) {
    throw new Error(
      'PERSONAL_MONGODB_URI is required; MONGODB_URI is never used'
    );
  }

  const manifest = JSON.parse(
    await fs.readFile(manifestPath, 'utf8')
  ) as PersonalImportManifest;
  const manifestDirectory = path.dirname(path.resolve(manifestPath));
  const buffers = new Map<string, Buffer>();
  for (const source of manifest.sources) {
    const sourcePath = path.isAbsolute(source.path)
      ? source.path
      : path.resolve(manifestDirectory, source.path);
    buffers.set(source.sourceId, await fs.readFile(sourcePath));
  }

  const preview = buildPersonalImportPreview(manifest, buffers);
  const result = await loadPersonalImport(preview, uri);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
};

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Unknown load error'}\n`
  );
  process.exitCode = 1;
});
