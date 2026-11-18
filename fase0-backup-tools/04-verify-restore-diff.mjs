import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { serializeValue, canonicalJson } from './lib/firestore-serializer.mjs';

function parseArgs(argv) {
  const args = {
    backupDir: '',
    project: '',
    database: '(default)',
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--backup-dir' && argv[i + 1]) args.backupDir = argv[++i];
    else if (token === '--project' && argv[i + 1]) args.project = argv[++i];
    else if (token === '--database' && argv[i + 1]) args.database = argv[++i];
  }
  return args;
}

async function collectAllTargetDocs(db) {
  const targetMap = new Map();

  async function walkCol(colRef) {
    const docRefs = await colRef.listDocuments();
    for (const docRef of docRefs) {
      const snap = await docRef.get();
      if (snap.exists) {
        targetMap.set(docRef.path, serializeValue(snap.data()));
      }
      const subCols = await docRef.listCollections();
      for (const subCol of subCols) {
        await walkCol(subCol);
      }
    }
  }

  const rootCols = await db.listCollections();
  for (const rootCol of rootCols) {
    await walkCol(rootCol);
  }
  return targetMap;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.backupDir || !args.project) {
    console.error(
      'Penggunaan: node 04-verify-restore-diff.mjs --backup-dir <FOLDER_BACKUP> --project <ID_PROYEK_UJI> [--database "(default)"]'
    );
    process.exit(1);
  }

  const backupDir = path.resolve(args.backupDir);
  const ndjsonPath = path.join(backupDir, 'documents.ndjson');
  const backupMap = new Map();

  const rl = readline.createInterface({
    input: fs.createReadStream(ndjsonPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    backupMap.set(record.path, record.data);
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

  console.log(`Memverifikasi hasil restore pada project=${args.project}, database=${args.database}...`);
  const targetMap = await collectAllTargetDocs(db);

  const missingInTarget = [];
  const extraInTarget = [];
  const dataMismatches = [];

  for (const [docPath, expectedData] of backupMap.entries()) {
    if (!targetMap.has(docPath)) {
      missingInTarget.push(docPath);
      continue;
    }
    const actualData = targetMap.get(docPath);
    if (canonicalJson(expectedData) !== canonicalJson(actualData)) {
      dataMismatches.push(docPath);
    }
  }

  for (const docPath of targetMap.keys()) {
    if (!backupMap.has(docPath)) {
      extraInTarget.push(docPath);
    }
  }

  const passed =
    missingInTarget.length === 0 &&
    extraInTarget.length === 0 &&
    dataMismatches.length === 0;

  const report = {
    verifiedAt: new Date().toISOString(),
    targetProjectId: args.project,
    targetDatabaseId: args.database,
    backupDocumentsCount: backupMap.size,
    targetDocumentsCount: targetMap.size,
    missingInTargetCount: missingInTarget.length,
    extraInTargetCount: extraInTarget.length,
    dataMismatchesCount: dataMismatches.length,
    passed,
    samples: {
      missingInTarget: missingInTarget.slice(0, 20),
      extraInTarget: extraInTarget.slice(0, 20),
      dataMismatches: dataMismatches.slice(0, 20),
    },
  };

  const reportPath = path.join(backupDir, `verify-report-${args.project}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log('=== HASIL VERIFIKASI RESTORE ===');
  console.log(`Jumlah dokumen backup : ${report.backupDocumentsCount}`);
  console.log(`Jumlah dokumen target : ${report.targetDocumentsCount}`);
  console.log(`Hilang di target      : ${report.missingInTargetCount}`);
  console.log(`Ekstra di target      : ${report.extraInTargetCount}`);
  console.log(`Ketidakcocokan isi    : ${report.dataMismatchesCount}`);
  console.log(`STATUS                : ${passed ? 'LULUS 100% COCOK' : 'GAGAL - ADA SELISIH'}`);
  console.log(`Laporan lengkap       : ${reportPath}`);

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error('GAGAL verifikasi diff:', err);
  process.exit(1);
});
