import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, stat, readdir, rm } from 'node:fs/promises';
import { existsSync, writeFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ArtifactRef } from '@strata-ctx/core-types';

export interface ArtifactStoreConfig {
  readonly rootDir?: string;
  readonly maxAgeDays?: number;
  readonly minRefCount?: number;
}

const DEFAULT_ROOT = join(homedir(), '.strata', 'artifacts');
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MIN_REF_COUNT = 0;

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactPath(rootDir: string, hash: string): string {
  const prefix = hash.slice(0, 2);
  return join(rootDir, prefix, hash);
}

function parseArtifactUri(uri: string): string | null {
  const match = uri.match(/^artifact:\/\/([0-9a-f]{64})$/);
  return match?.[1] ?? null;
}

export class ArtifactStore {
  private readonly rootDir: string;
  private readonly maxAgeDays: number;
  private readonly minRefCount: number;
  private readonly refCounts: Map<string, number> = new Map();

  constructor(config: ArtifactStoreConfig = {}) {
    this.rootDir = config.rootDir ?? DEFAULT_ROOT;
    this.maxAgeDays = config.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
    this.minRefCount = config.minRefCount ?? DEFAULT_MIN_REF_COUNT;
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
  }

  put(bytes: Uint8Array): ArtifactRef {
    const hash = sha256Bytes(bytes);
    const uri = `artifact://${hash}`;
    const path = artifactPath(this.rootDir, hash);

    if (!existsSync(path)) {
      const dir = join(this.rootDir, hash.slice(0, 2));
      mkdirSync(dir, { recursive: true });
      const fd = openSync(path, 'wx');
      try {
        writeFileSync(fd, bytes);
      } finally {
        closeSync(fd);
      }
    }

    const refCount = this.refCounts.get(hash) ?? 0;
    this.refCounts.set(hash, refCount + 1);

    return { uri, sha256: hash, bytes: bytes.length, kind: 'other' };
  }

  async get(uri: ArtifactRef): Promise<Uint8Array | null> {
    const hash = parseArtifactUri(uri.uri);
    if (!hash) return null;

    const path = artifactPath(this.rootDir, hash);
    if (!existsSync(path)) return null;

    const data = await readFile(path);
    return new Uint8Array(data);
  }

  async delete(uri: ArtifactRef): Promise<boolean> {
    const hash = parseArtifactUri(uri.uri);
    if (!hash) return false;

    const refCount = this.refCounts.get(hash) ?? 0;
    if (refCount > 1) {
      return false;
    }

    const path = artifactPath(this.rootDir, hash);
    if (!existsSync(path)) return false;

    await unlink(path);
    this.refCounts.delete(hash);

    const dir = join(this.rootDir, hash.slice(0, 2));
    try {
      const entries = await readdir(dir);
      if (entries.length === 0) {
        await rm(dir, { recursive: true });
      }
    } catch {
      // Directory not empty or doesn't exist, ignore
    }

    return true;
  }

  addRef(uri: ArtifactRef): void {
    const hash = parseArtifactUri(uri.uri);
    if (!hash) return;
    const refCount = this.refCounts.get(hash) ?? 0;
    this.refCounts.set(hash, refCount + 1);
  }

  removeRef(uri: ArtifactRef): void {
    const hash = parseArtifactUri(uri.uri);
    if (!hash) return;
    const refCount = this.refCounts.get(hash) ?? 0;
    if (refCount <= 1) {
      this.refCounts.delete(hash);
    } else {
      this.refCounts.set(hash, refCount - 1);
    }
  }

  getRefCount(uri: ArtifactRef): number {
    const hash = parseArtifactUri(uri.uri);
    if (!hash) return 0;
    return this.refCounts.get(hash) ?? 0;
  }

  async gc(maxAgeDays?: number, minRefCount?: number): Promise<number> {
    const ageThreshold = (maxAgeDays ?? this.maxAgeDays) * 24 * 60 * 60 * 1000;
    const refThreshold = minRefCount ?? this.minRefCount;
    const now = Date.now();
    let deleted = 0;

    const prefixes = await readdir(this.rootDir).catch(() => []);
    for (const prefix of prefixes) {
      const prefixDir = join(this.rootDir, prefix);
      const files = await readdir(prefixDir).catch(() => []);
      for (const file of files) {
        if (file.length !== 64) continue;
        const path = join(prefixDir, file);
        const stats = await stat(path).catch(() => null);
        if (!stats) continue;

        const age = now - stats.mtimeMs;
        const refCount = this.refCounts.get(file) ?? 0;

        if (age >= ageThreshold && refCount <= refThreshold) {
          await unlink(path);
          this.refCounts.delete(file);
          deleted += 1;
        }
      }
      try {
        const remaining = await readdir(prefixDir);
        if (remaining.length === 0) {
          await rm(prefixDir, { recursive: true });
        }
      } catch {
        // Directory not empty or doesn't exist, ignore
      }
    }

    return deleted;
  }

  async close(): Promise<void> {
  }
}

export function createArtifactStore(config?: ArtifactStoreConfig): ArtifactStore {
  return new ArtifactStore(config);
}