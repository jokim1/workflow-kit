import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { CONFIG_FILENAME, resolveRepoRoot, runCommandCapture } from './state.ts';
import { resolvePipelaneInstallSpec } from './install-source.ts';

export interface BootstrapOptions {
  projectName?: string;
}

export interface BootstrapResult {
  repoRoot: string;
  displayName: string;
  installedPackage: boolean;
  initializedRepo: boolean;
  createdClaude: boolean;
  codexHome: string;
  installedWrappers: string[];
}

function hasPipelaneDependency(repoRoot: string): boolean {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  if (!existsSync(packageJsonPath)) {
    return false;
  }

  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return Boolean(
      pkg.dependencies?.pipelane ||
      pkg.devDependencies?.pipelane ||
      pkg.optionalDependencies?.pipelane,
    );
  } catch {
    return false;
  }
}

function localPipelaneInstalled(repoRoot: string): boolean {
  return existsSync(path.join(repoRoot, 'node_modules', 'pipelane', 'package.json'));
}

function inferProjectName(repoRoot: string, provided: string | undefined): string {
  const trimmed = provided?.trim() ?? '';
  return trimmed || path.basename(repoRoot);
}

function runOrThrow(repoRoot: string, command: string, args: string[]): { stdout: string; stderr: string } {
  const result = runCommandCapture(command, args, { cwd: repoRoot, env: process.env });
  if (!result.ok) {
    const rendered = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(rendered || `${command} ${args.join(' ')} failed in ${repoRoot}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function runLocalPipelane(repoRoot: string, args: string[]): string {
  const result = runOrThrow(repoRoot, 'npx', ['--no-install', 'pipelane', ...args]);
  return [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
}

function parseSetupOutput(stdout: string): { createdClaude: boolean; codexHome: string; installedWrappers: string[] } {
  const createdClaude = stdout.includes('Created local CLAUDE.md from the Pipelane template.');
  const codexHome = stdout.match(/Installed Codex wrappers in (.+)/)?.[1]?.trim() ?? '';
  const wrapperCsv = stdout.match(/Slash commands: (.+)/)?.[1]?.trim() ?? '';
  const installedWrappers = wrapperCsv
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return { createdClaude, codexHome, installedWrappers };
}

function readDisplayName(repoRoot: string): string {
  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(configPath)) {
    return path.basename(repoRoot);
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { displayName?: string };
    return parsed.displayName?.trim() || path.basename(repoRoot);
  } catch {
    return path.basename(repoRoot);
  }
}

export function parseBootstrapArgs(argv: string[]): BootstrapOptions {
  const options: BootstrapOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--project') {
      options.projectName = argv[index + 1] ?? '';
      index += 1;
      continue;
    }
    if (token === '--help' || token === '-h') {
      process.stdout.write('pipelane bootstrap [--project "Project Name"]\n');
      process.exit(0);
    }
    throw new Error(`Unknown flag for pipelane bootstrap: ${token}`);
  }
  return options;
}

export function runBootstrap(cwd: string, options: BootstrapOptions): BootstrapResult {
  const repoRoot = resolveRepoRoot(cwd, true);
  const configPath = path.join(repoRoot, CONFIG_FILENAME);
  const initializedRepo = !existsSync(configPath);
  const projectName = inferProjectName(repoRoot, options.projectName);

  let installedPackage = false;
  if (!localPipelaneInstalled(repoRoot)) {
    const installArgs = hasPipelaneDependency(repoRoot)
      ? ['install']
      : ['install', '--save-dev', resolvePipelaneInstallSpec()];
    runOrThrow(repoRoot, 'npm', installArgs);
    installedPackage = true;
  }

  if (initializedRepo) {
    runLocalPipelane(repoRoot, ['init', '--project', projectName]);
  }

  const setupOutput = runLocalPipelane(repoRoot, ['setup']);
  const parsedSetup = parseSetupOutput(setupOutput);

  return {
    repoRoot,
    displayName: readDisplayName(repoRoot),
    installedPackage,
    initializedRepo,
    createdClaude: parsedSetup.createdClaude,
    codexHome: parsedSetup.codexHome,
    installedWrappers: parsedSetup.installedWrappers,
  };
}
