import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const sourceDb = path.join(root, 'backend', 'data', 'newshub.sqlite');
const sourceUploads = path.join(root, 'backend', 'uploads');
const backupDir = path.join(root, 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const targetDb = path.join(backupDir, `newshub-${stamp}.sqlite`);
if (fs.existsSync(sourceDb)) fs.copyFileSync(sourceDb, targetDb);
const manifest = {
  createdAt: new Date().toISOString(),
  database: fs.existsSync(sourceDb) ? targetDb : null,
  uploadsIncluded: fs.existsSync(sourceUploads),
};
fs.writeFileSync(path.join(backupDir, `manifest-${stamp}.json`), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest, null, 2));
