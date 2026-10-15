import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** Encrypted durable records. Key material is supplied by the hosting secret store. */
export class Store {
  private db: DatabaseSync;
  constructor(path: string, private key: Buffer) {
    if (key.length !== 32) throw new Error('WORK_ENCRYPTION_KEY must decode to 32 bytes');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records (ns TEXT NOT NULL, k TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(ns,k));');
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  put(ns: string, key: string, value: unknown, expires = 0) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(ns+'\0'+key));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const encrypted = Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString('base64');
    this.db.prepare('INSERT OR REPLACE INTO records VALUES (?,?,?,?)').run(ns,key,encrypted,expires);
  }
  get<T>(ns: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT value,expires FROM records WHERE ns=? AND k=?').get(ns,key) as {value:string;expires:number}|undefined;
    if (!row || (row.expires && row.expires <= Date.now())) return undefined;
    const encrypted = Buffer.from(row.value,'base64');
    const decipher = createDecipheriv('aes-256-gcm',this.key,encrypted.subarray(0,12));
    decipher.setAAD(Buffer.from(ns+'\0'+key));
    decipher.setAuthTag(encrypted.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]).toString('utf8')) as T;
  }
  delete(ns: string, key: string) { this.db.prepare('DELETE FROM records WHERE ns=? AND k=?').run(ns,key); }
  prune() { this.db.prepare('DELETE FROM records WHERE expires>0 AND expires<=?').run(Date.now()); }
  close() { this.db.close(); }
}
export const opaque = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
