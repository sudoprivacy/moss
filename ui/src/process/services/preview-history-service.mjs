import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';

const HISTORY_FOLDER_NAME = 'preview-history';
const INDEX_FILE_NAME = 'index.json';
const MAX_VERSIONS_PER_TARGET = 50;

class PreviewHistoryService {
  getBaseDir() {
    return path.join(app.getPath('cache'), HISTORY_FOLDER_NAME);
  }

  async ensureDir(targetDir) {
    await fs.mkdir(targetDir, { recursive: true });
  }

  buildIdentity(target) {
    const keyParts = [
      target.filePath ? `path:${target.filePath}` : '',
      target.workspace ? `workspace:${target.workspace}` : '',
      target.fileName ? `file:${target.fileName}` : '',
      target.title ? `title:${target.title}` : '',
      target.language ? `lang:${target.language}` : '',
      target.conversationId ? `conversation:${target.conversationId}` : '',
      `type:${target.contentType}`,
    ].filter(Boolean);
    const identity = keyParts.join('|') || `anonymous|${target.contentType}`;
    const digest = crypto.createHash('sha1').update(identity).digest('hex');
    return { identity, digest };
  }

  async readIndex(targetDir, identity, target) {
    await this.ensureDir(targetDir);
    const indexPath = path.join(targetDir, INDEX_FILE_NAME);
    try {
      const parsed = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
      if (!Array.isArray(parsed.versions)) parsed.versions = [];
      return parsed;
    } catch {
      return { identity, target, versions: [] };
    }
  }

  async writeIndex(targetDir, index) {
    await fs.writeFile(path.join(targetDir, INDEX_FILE_NAME), JSON.stringify(index, null, 2), 'utf-8');
  }

  getSnapshotFileName(snapshotId) {
    return `${snapshotId}.md`;
  }

  createSnapshotInfo({ snapshotId, content, createdAt, target, relativePath }) {
    return {
      id: snapshotId,
      label: new Date(createdAt).toISOString(),
      createdAt,
      size: Buffer.byteLength(content, 'utf-8'),
      contentType: target.contentType,
      fileName: target.fileName,
      filePath: target.filePath,
      storagePath: relativePath,
    };
  }

  normalizeSnapshot(snapshot) {
    const { storagePath, ...rest } = snapshot;
    return rest;
  }

  async list(target) {
    const { identity, digest } = this.buildIdentity(target);
    const targetDir = path.join(this.getBaseDir(), digest);
    const index = await this.readIndex(targetDir, identity, target);
    return index.versions.map((item) => this.normalizeSnapshot(item));
  }

  async save(target, content) {
    const { identity, digest } = this.buildIdentity(target);
    const targetDir = path.join(this.getBaseDir(), digest);
    const index = await this.readIndex(targetDir, identity, target);
    const createdAt = Date.now();
    const snapshotId = `${createdAt}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshotPath = path.join(targetDir, this.getSnapshotFileName(snapshotId));
    await fs.writeFile(snapshotPath, content, 'utf-8');

    const snapshot = this.createSnapshotInfo({
      snapshotId,
      content,
      createdAt,
      target,
      relativePath: path.relative(this.getBaseDir(), snapshotPath),
    });
    index.versions.unshift(snapshot);
    while (index.versions.length > MAX_VERSIONS_PER_TARGET) {
      const removed = index.versions.pop();
      if (!removed) continue;
      void fs.rm(path.join(this.getBaseDir(), removed.storagePath), { force: true }).catch(() => undefined);
    }
    await this.writeIndex(targetDir, index);
    return this.normalizeSnapshot(snapshot);
  }

  async getContent(target, snapshotId) {
    const { identity, digest } = this.buildIdentity(target);
    const targetDir = path.join(this.getBaseDir(), digest);
    const index = await this.readIndex(targetDir, identity, target);
    const snapshot = index.versions.find((item) => item.id === snapshotId);
    if (!snapshot) return null;
    const content = await fs.readFile(path.join(this.getBaseDir(), snapshot.storagePath), 'utf-8');
    return { snapshot: this.normalizeSnapshot(snapshot), content };
  }
}

export const previewHistoryService = new PreviewHistoryService();
