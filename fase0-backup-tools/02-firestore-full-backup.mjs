import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { initializeApp, applicationDefault, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { serializeValue } from './lib/firestore-serializer.mjs';

function parseArgs(argv) {
  const args = {
    project: 'flash-lead-kwpgt',
    database: 'ai-studio-655beb1c-8e1a-4a3c-8e9c-6d8a3dcc3557',
    out: `./firestore-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--project' && argv[i + 1]) args.project = argv[++i];
    else if (token === '--database' && argv[i + 1]) args.database = argv[++i];
    else if (token === '--out' && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

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

  const ndjsonPath = path.join(outDir, 'documents.ndjson');
  const writeStream = fs.createWriteStream(ndjsonPath, { encoding: 'utf8' });

  const stats = {
    projectId: args.project,
    databaseId: args.database,
    exportedAt: new Date().toISOString(),
    method: 'admin-sdk-recursive-listCollections-listDocuments-plus-collectionGroup-items',
    rootCollections: [],
    subcollectionNames: new Set(),
    perCollectionCounts: {},
    totalDocuments: 0,
    orphanParentRefsCount: 0,
    totalReadEstimate: 0,
    collectionGroupItemsCount: 0,
    missingFromRecursiveFoundByCollectionGroup: [],
    warnings: [],
  };

  const capturedPaths = new Set();

  function incrementCount(colPath) {
    stats.perCollectionCounts[colPath] = (stats.perCollectionCounts[colPath] || 0) + 1;
  }

  async function traverseCollection(colRef, depth) {
    const docRefs = await colRef.listDocuments();
    for (const docRef of docRefs) {
      stats.totalReadEstimate += 1;
      const snap = await docRef.get();

      if (snap.exists) {
        const record = {
          path: docRef.path,
          id: docRef.id,
          collectionPath: colRef.path,
          depth,
          createTime: snap.createTime ? snap.createTime.toDate().toISOString() : null,
          updateTime: snap.updateTime ? snap.updateTime.toDate().toISOString() : null,
          data: serializeValue(snap.data()),
        };
        writeStream.write(`${JSON.stringify(record)}\n`);
        capturedPaths.add(docRef.path);
        stats.totalDocuments += 1;
        incrementCount(colRef.path);
      } else {
        stats.orphanParentRefsCount += 1;
      }

      const subCols = await docRef.listCollections();
      for (const subCol of subCols) {
        stats.subcollectionNames.add(subCol.id);
        await traverseCollection(subCol, depth + 1);
      }
    }
  }

  console.log('Mulai backup Firestore (read-only)...');
  console.log(`Project  : ${args.project}`);
  console.log(`Database : ${args.database}`);
  console.log(`Output   : ${outDir}`);

  const rootCols = await db.listCollections();
  stats.rootCollections = rootCols.map((c) => c.id).sort();

  for (const rootCol of rootCols) {
    console.log(`-> Membaca koleksi root: ${rootCol.id}`);
    await traverseCollection(rootCol, 1);
  }

  try {
    const itemsSnap = await db.collectionGroup('items').get();
    stats.collectionGroupItemsCount = itemsSnap.size;
    stats.totalReadEstimate += itemsSnap.size;
    for (const itemDoc of itemsSnap.docs) {
      if (!capturedPaths.has(itemDoc.ref.path)) {
        stats.missingFromRecursiveFoundByCollectionGroup.push(itemDoc.ref.path);
        const record = {
          path: itemDoc.ref.path,
          id: itemDoc.id,
          collectionPath: itemDoc.ref.parent.path,
          depth: itemDoc.ref.path.split('/').length / 2,
          createTime: itemDoc.createTime ? itemDoc.createTime.toDate().toISOString() : null,
          updateTime: itemDoc.updateTime ? itemDoc.updateTime.toDate().toISOString() : null,
          data: serializeValue(itemDoc.data()),
        };
        writeStream.write(`${JSON.stringify(record)}\n`);
        capturedPaths.add(itemDoc.ref.path);
        stats.totalDocuments += 1;
        incrementCount(itemDoc.ref.parent.path);
      }
    }
    if (stats.missingFromRecursiveFoundByCollectionGroup.length > 0) {
      stats.warnings.push(
        `Ditemukan ${stats.missingFromRecursiveFoundByCollectionGroup.length} dokumen subkoleksi 'items' via collectionGroup.`
      );
    }
  } catch (err) {
    stats.warnings.push(`Pengecekan silang collectionGroup('items') gagal: ${err.message}`);
  }

  await new Promise((resolve, reject) => {
    writeStream.end(() => resolve());
    writeStream.on('error', reject);
  });

  const ndjsonHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(ndjsonPath))
    .digest('hex');

  const manifest = {
    projectId: stats.projectId,
    databaseId: stats.databaseId,
    exportedAt: stats.exportedAt,
    method: stats.method,
    rootCollections: stats.rootCollections,
    subcollectionNames: Array.from(stats.subcollectionNames).sort(),
    totalDocuments: stats.totalDocuments,
    orphanParentRefsCount: stats.orphanParentRefsCount,
    collectionGroupItemsCount: stats.collectionGroupItemsCount,
    missingFromRecursiveFoundByCollectionGroup: stats.missingFromRecursiveFoundByCollectionGroup,
    totalReadEstimate: stats.totalReadEstimate,
    perCollectionCounts: stats.perCollectionCounts,
    warnings: stats.warnings,
    files: {
      'documents.ndjson': {
        sha256: ndjsonHash,
        bytes: fs.statSync(ndjsonPath).size,
      },
    },
  };

  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('=== BACKUP FIRESTORE SELESAI ===');
  console.log(`Total dokumen       : ${manifest.totalDocuments}`);
  console.log(`Koleksi root        : ${manifest.rootCollections.join(', ')}`);
  console.log(`Subkoleksi ditemukan: ${manifest.subcollectionNames.join(', ') || '(tidak ada)'}`);
  console.log(`SHA-256 NDJSON      : ${ndjsonHash}`);
  console.log(`Manifes disimpan di : ${manifestPath}`);
}

main().catch((err) => {
  console.error('GAGAL backup Firestore:', err);
  process.exit(1);
});
