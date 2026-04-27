import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import path from 'node:path';

import { normalizePath, runGit } from './state.ts';

const STATUS_DIGEST_MAX_FILE_BYTES = 1024 * 1024;
const STATUS_DIGEST_MAX_DIRTY_PATHS = 512;
const STATUS_DIGEST_MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export interface ReadWorktreeStatusSnapshotOptions {
  includeStatusDigest?: boolean;
}

export interface WorktreeStatusSnapshot {
  repoRoot: string;
  exists: boolean;
  branchName: string;
  commonDir: string;
  head: string;
  statusDigest: string;
  dirty: boolean;
  statusEntryCount: number;
  changedPaths: string[];
  statusDigestReliable: boolean;
  statusDigestWarnings: string[];
}

export function readWorktreeStatusSnapshot(
  repoRoot: string,
  options: ReadWorktreeStatusSnapshotOptions = {},
): WorktreeStatusSnapshot {
  const normalizedRoot = normalizePath(repoRoot);
  if (!existsSync(normalizedRoot)) {
    return {
      repoRoot: normalizedRoot,
      exists: false,
      branchName: '',
      commonDir: '',
      head: '',
      statusDigest: '',
      dirty: false,
      statusEntryCount: 0,
      changedPaths: [],
      statusDigestReliable: false,
      statusDigestWarnings: ['repository path does not exist'],
    };
  }

  const branchName = runGit(normalizedRoot, ['branch', '--show-current'], true)?.trim() ?? '';
  const commonDirRaw = runGit(normalizedRoot, ['rev-parse', '--git-common-dir'], true)?.trim() ?? '';
  const commonDir = commonDirRaw ? normalizePath(path.resolve(normalizedRoot, commonDirRaw)) : '';
  const head = runGit(normalizedRoot, ['rev-parse', 'HEAD'], true)?.trim() ?? '';
  const status = captureGitBytes(normalizedRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const statusRaw = status.output.toString('utf8');
  const statusEntries = parseStatusEntries(statusRaw);
  const changedPaths = [...new Set(statusEntries.flatMap((entry) => entry.paths))].sort();
  const digest = commonDir && options.includeStatusDigest
    ? computeWorktreeStatusDigest(normalizedRoot, status, statusEntries)
    : {
      digest: '',
      reliable: status.ok,
      warnings: status.ok ? [] : [`git status failed: ${status.error}`],
    };

  return {
    repoRoot: normalizedRoot,
    exists: true,
    branchName,
    commonDir,
    head,
    statusDigest: digest.digest,
    dirty: status.ok ? statusRaw.length > 0 : true,
    statusEntryCount: statusEntries.length,
    changedPaths,
    statusDigestReliable: digest.reliable,
    statusDigestWarnings: digest.warnings,
  };
}

interface GitBytesCapture {
  ok: boolean;
  output: Buffer;
  error: string;
}

interface StatusEntry {
  xy: string;
  paths: string[];
}

interface WorktreeStatusDigestResult {
  digest: string;
  reliable: boolean;
  warnings: string[];
}

function captureGitBytes(repoRoot: string, args: string[]): GitBytesCapture {
  const result = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'buffer',
    maxBuffer: STATUS_DIGEST_MAX_GIT_OUTPUT_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? '');
  if (result.error) {
    return { ok: false, output: stdout, error: result.error.message };
  }
  if (result.status !== 0) {
    const detail = stderr.toString('utf8').trim() || `exit ${result.status ?? 'unknown'}`;
    return { ok: false, output: stdout, error: detail };
  }
  return { ok: true, output: stdout, error: '' };
}

function computeWorktreeStatusDigest(
  repoRoot: string,
  status: GitBytesCapture,
  statusEntries: StatusEntry[],
): WorktreeStatusDigestResult {
  const hash = createHash('sha256');
  const warnings: string[] = [];
  if (!status.ok) warnings.push(`git status failed: ${status.error}`);

  hash.update('status\0');
  hash.update(status.output);
  hash.update('\0diff-raw\0');
  const diff = captureGitBytes(repoRoot, ['diff', '--raw', '--full-index', '-z']);
  hash.update(diff.output);
  if (!diff.ok) {
    hash.update(`\0diff-error:${diff.error}\0`);
    warnings.push(`git diff failed: ${diff.error}`);
  }
  hash.update('\0cached-raw\0');
  const cached = captureGitBytes(repoRoot, ['diff', '--cached', '--raw', '--full-index', '-z']);
  hash.update(cached.output);
  if (!cached.ok) {
    hash.update(`\0cached-diff-error:${cached.error}\0`);
    warnings.push(`git diff --cached failed: ${cached.error}`);
  }
  hash.update('\0paths\0');

  const opaqueDirectories = statusEntries
    .filter((entry) => entry.xy === '??' && entry.paths.some((entryPath) => entryPath.endsWith('/')))
    .flatMap((entry) => entry.paths.filter((entryPath) => entryPath.endsWith('/')));
  if (opaqueDirectories.length > 0) {
    warnings.push(`untracked directories are opaque to route approval: ${opaqueDirectories.slice(0, 3).join(', ')}${opaqueDirectories.length > 3 ? `, +${opaqueDirectories.length - 3} more` : ''}`);
  }

  const sortedPaths = [...new Set(statusEntries.flatMap((entry) => entry.paths))].sort();
  hash.update(`count:${sortedPaths.length}\0`);
  if (sortedPaths.length > STATUS_DIGEST_MAX_DIRTY_PATHS) {
    warnings.push(`dirty path count ${sortedPaths.length} exceeds route approval budget ${STATUS_DIGEST_MAX_DIRTY_PATHS}`);
    hash.update(`truncated-paths:${sortedPaths.length - STATUS_DIGEST_MAX_DIRTY_PATHS}\0`);
  }

  const digestPaths = sortedPaths.slice(0, STATUS_DIGEST_MAX_DIRTY_PATHS);
  hash.update('files\0');
  for (const relativePath of digestPaths) {
    hash.update(relativePath);
    hash.update('\0');
    hashPathForStatus(hash, warnings, repoRoot, relativePath);
    hash.update('\0');
  }
  hash.update('warnings\0');
  for (const warning of warnings) hash.update(`${warning}\0`);

  return {
    digest: hash.digest('hex'),
    reliable: warnings.length === 0,
    warnings,
  };
}

function parseStatusEntries(statusRaw: string): StatusEntry[] {
  const entries = statusRaw.split('\0').filter(Boolean);
  const parsed: StatusEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const xy = entry.slice(0, 2);
    const relativePath = entry.length > 3 ? entry.slice(3) : '';
    if (!relativePath) {
      continue;
    }
    if (xy[0] === 'R' || xy[0] === 'C') {
      const sourcePath = entries[index + 1] ?? '';
      parsed.push({ xy, paths: sourcePath ? [relativePath, sourcePath] : [relativePath] });
      index += 1;
      continue;
    }
    parsed.push({ xy, paths: [relativePath] });
  }

  return parsed;
}

function hashPathForStatus(
  hash: ReturnType<typeof createHash>,
  warnings: string[],
  repoRoot: string,
  relativePath: string,
): void {
  const targetPath = path.join(repoRoot, relativePath);
  try {
    const stat = lstatSync(targetPath);
    hash.update(stat.isDirectory() ? 'dir' : stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : 'other');
    hash.update(`:${stat.mode}:${stat.size}:${Math.trunc(stat.mtimeMs)}:`);
    if (stat.isSymbolicLink()) {
      hash.update(readlinkSync(targetPath));
      return;
    }
    if (stat.isFile()) {
      if (stat.size > STATUS_DIGEST_MAX_FILE_BYTES) {
        warnings.push(`dirty file exceeds route approval size budget: ${relativePath}`);
        hash.update('file-too-large');
        return;
      }
      hash.update('full-content:');
      hashFileRange(hash, openSync(targetPath, 'r'), 0, stat.size);
    } else {
      hash.update('no-file-content');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`dirty path is unreadable: ${relativePath}`);
    hash.update(`unreadable:${message}`);
  }
}

function hashFileRange(hash: ReturnType<typeof createHash>, fd: number, start: number, length: number): void {
  try {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, length)));
    let remaining = length;
    let position = start;

    while (remaining > 0) {
      const bytesToRead = Math.min(buffer.length, remaining);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      remaining -= bytesRead;
      position += bytesRead;
    }
  } finally {
    closeSync(fd);
  }
}
