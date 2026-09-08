import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildPersonalImportPreview } from '../services/personalImport/PersonalImportService';
import type { PersonalImportManifest } from '../services/personalImport/types';

const getArgument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const main = async () => {
  const manifestPath = getArgument('--manifest');
  const outputPath =
    getArgument('--output') ?? 'data/personal-import-preview.json';
  if (!manifestPath) {
    throw new Error(
      'Usage: pnpm preview:personal-import -- --manifest <path> [--output <path>]'
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
  const resolvedOutput = path.resolve(outputPath);
  await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });
  await fs.writeFile(resolvedOutput, `${JSON.stringify(preview, null, 2)}\n`);

  process.stdout.write(
    `${JSON.stringify(
      {
        output: resolvedOutput,
        writePerformed: preview.writePerformed,
        readyForLoad: preview.readyForLoad,
        transactionCount: preview.transactions.length,
        blockers: preview.blockers,
        accounts: preview.accounts,
        review: preview.review,
      },
      null,
      2
    )}\n`
  );
};

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Unknown preview error'}\n`
  );
  process.exitCode = 1;
});
