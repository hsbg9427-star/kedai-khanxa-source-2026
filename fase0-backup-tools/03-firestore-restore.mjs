import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { deserializeValue } from './lib/firestore-serializer.mjs';

const PROD_PROJECT_ID = 'flash-lead-kwpgt';

function parseArgs(argv) {
  const args = {
    backupDir: '',
    project: '',
    database: '(default)',
    dryRun: false,
    allowProductionOverwrite: '',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--backup-dir' && argv[i + 1]) args.backupDir = argv[++i];
    else if (token === '--project' && argv[i + 1]) args.project = argv[++i];
    else if (token === '--database' && argv[i + 1]) args.database = argv[++i];
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--allow-production-overwrite' && argv[i + 1]) {
      args.allowProductionOverwrite = argv[++i];
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.backupDir || !args.project) {
    console.error(
      'Penggunaan: node 03-firestore-restore.mjs --backup-dir <FOLDER_BACKUP> --project <ID_PROYEK_UJI_TERPISAH> [--database "(default)"] [--dry-run]'
    );
    process.exit(1);
  }

  if (
    args.project === PROD_PROJECT_ID &&
    args.allowProductionOverwrite !== 'I_UNDERSTAND_THE_RISK'
  ) {
    console.error(
      `DITOLAK: Target --project adalah proyek produksi (${PROD_PROJECT_ID}). Untuk uji Tahap 0, WAJIB gunakan proyek Firebase terpisah yang kosong!`
    );
    process.exit(1);
  }

  const backupDir = path.resolve(args.backupDir);
  const manifestPath = path.join(backupDir, 'manifest.json');
  const ndjsonPath = path.join(backupDir, 'documents.ndjson');

  if (!fs.existsSync(manifestPath) || !fs.existsSync(ndjsonPath)) {
    console.error('manifest.json atau documents.ndjson tidak ditemukan di:', backupDir);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const actualHash = crypto.createHash('sha256').update(fs.readFileSync(ndjsonPath)).digest('hex');
  const expectedHash = manifest.files?.['documents.ndjson']?.sha256;

  if (expectedHash && actualHash !== expectedHash) {
    console.error('BATAL: Checksum SHA-256 documents.ndjson tidak cocok dengan manifest.json!');
    console.error('Expected:', expectedHash);
    console.error('Actual  :', actualHash);
    process.exit(1);
  }

  const app = getApps().length
    ? getApps()[0]
    : initializeApp({
        credential: applicationDefault(),
        projectId: args.project,
      });

  const db =
    args.database === '(default)'
      ? getFirestore(app)
      : getFirestore(app, args.database);

  console.log('=== MULAI RESTORE FIRESTORE ===');
  console.log(`Sumber backup : ${backupDir}`);
  console.log(`Target project: ${args.project}`);
  console.log(`Target DB     : ${args.database}`);
  console.log(`Mode dry-run  : ${args.dryRun ? 'YA (tidak menulis ke database)' : 'TIDAK (menulis dokumen)'}`);

  const rl = readline.createInterface({
    input: fs.createReadStream(ndjsonPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let batch = db.batch();
  let opsInBatch = 0;
  let totalRestored = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    const data = deserializeValue(record.data, db);

    if (!args.dryRun) {
      const ref = db.doc(record.path);
      batch.set(ref, data);
      opsInBatch += 1;

      if (opsInBatch >= 400) {
        await batch.commit();
        batch = db.batch();
        opsInBatch = 0;
      }
    }

    totalRestored += 1;
    if (totalRestored % 500 === 0) {
      console.log(`Progress restore: ${totalRestored}/${manifest.totalDocuments} dokumen...`);
    }
  }

  if (!args.dryRun && opsInBatch > 0) {
    await batch.commit();
  }

  if (totalRestored !== manifest.totalDocuments) {
    console.warn(
      `PERINGATAN: Jumlah baris direstore (${totalRestored}) berbeda dari manifest (${manifest.totalDocuments}).`
    );
    process.exit(1);
  }

  console.log('=== RESTORE SELESAI ===');
  console.log(`Total dokumen diproses: ${totalRestored}`);
}

main().catch((err) => {
  console.error('GAGAL restore Firestore:', err);
  process.exit(1);
});
