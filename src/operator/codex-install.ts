import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { installGlobalRuntime } from './global-runtime.ts';
import { aliasCommandName, homeCodexDir, readJsonFile, resolveWorkflowAliases, type WorkflowCommand, WORKFLOW_COMMANDS, writeJsonFile } from './state.ts';

const MANAGED_CODEX_SKILLS_FILENAME = 'managed-skills.json';
const MANAGED_PIPELANE_DIR = '.pipelane';
const PIPELANE_SKILL_MARKER = 'Run the generic pipelane wrapper for this repo.';
const INIT_PIPELANE_SKILL_NAME = 'init-pipelane';

interface ManagedCodexSkillsManifest {
  version: number;
  repos: Record<string, string[]>;
}

function buildSkill(slashAlias: string, codexHome: string): string {
  return `---
name: ${aliasCommandName(slashAlias)}
version: 1.0.0
description: Run the pipelane command currently mapped to ${slashAlias} in this repo.
allowed-tools:
  - Bash
---

Run the generic pipelane wrapper for this repo.

1. Parse any arguments that appear after \`${slashAlias}\` in the user's message.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`${codexHome}/skills/${MANAGED_PIPELANE_DIR}/bin/run-pipelane.sh --alias ${slashAlias} <parsed arguments>\`
4. Stream the command output directly.
5. If the current repo is not pipelane enabled, return the refusal unchanged.
`;
}

function buildBootstrapSkill(codexHome: string): string {
  return `---
name: ${INIT_PIPELANE_SKILL_NAME}
version: 1.0.0
description: Bootstrap the current repo with pipelane.
allowed-tools:
  - Bash
---

${PIPELANE_SKILL_MARKER}

1. Parse any arguments that appear after \`/${INIT_PIPELANE_SKILL_NAME}\` in the user's message.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`${codexHome}/skills/${MANAGED_PIPELANE_DIR}/bin/bootstrap-pipelane.sh <parsed arguments>\`
4. Stream the command output directly.
5. If setup changed the slash command inventory, tell the user to reopen Codex if needed.
`;
}

function buildRunScript(): string {
  return `#!/bin/sh
set -eu

if [ "$#" -lt 1 ]; then
  echo "Usage: run-pipelane.sh <command> [args...]" >&2
  exit 64
fi

subcommand="$1"
shift

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "This command only works inside a pipelane repo." >&2
  exit 2
fi

if [ ! -f "$repo_root/.pipelane.json" ]; then
  echo "This repo is not pipelane enabled. Run /init-pipelane or pipelane bootstrap first." >&2
  exit 2
fi

if [ "$subcommand" = "--alias" ]; then
  if [ "$#" -lt 1 ]; then
    echo "Usage: run-pipelane.sh --alias </command> [args...]" >&2
    exit 64
  fi

  alias_name="$1"
  shift

  resolved_command="$(node - "$repo_root" "$alias_name" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = process.argv[2];
const aliasName = (process.argv[3] || '').trim().toLowerCase();
const configPath = path.join(repoRoot, '.pipelane.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const commands = ['devmode', 'new', 'resume', 'pr', 'merge', 'deploy', 'clean', 'status', 'doctor', 'rollback'];
const defaults = {
  devmode: '/devmode',
  new: '/new',
  resume: '/resume',
  pr: '/pr',
  merge: '/merge',
  deploy: '/deploy',
  clean: '/clean',
  status: '/status',
  doctor: '/doctor',
  rollback: '/rollback',
};

const normalize = (value, fallback) => {
  const raw = String(value || fallback).trim().toLowerCase();
  return raw.startsWith('/') ? raw : '/' + raw;
};

const aliases = Object.fromEntries(commands.map((command) => [
  command,
  normalize(config.aliases?.[command], defaults[command]),
]));

for (const command of commands) {
  if (aliases[command] === aliasName) {
    process.stdout.write(command);
    process.exit(0);
  }
}

process.exit(3);
NODE
)"

  if [ -z "$resolved_command" ]; then
    echo "Alias $alias_name is not configured for this repo. Rerun pipelane:setup if aliases changed." >&2
    exit 2
  fi

  subcommand="$resolved_command"
fi

cd "$repo_root"
exec npm run "pipelane:$subcommand" -- "$@"
`;
}

function buildBootstrapScript(pipelaneBinPath: string): string {
  return `#!/bin/sh
set -eu

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
exec "${pipelaneBinPath}" bootstrap "$@"
`;
}

function managedCodexSkillsPath(skillsRoot: string): string {
  return path.join(skillsRoot, MANAGED_PIPELANE_DIR, MANAGED_CODEX_SKILLS_FILENAME);
}

function skillDocPath(skillsRoot: string, skillName: string): string {
  return path.join(skillsRoot, skillName, 'SKILL.md');
}

function isManagedPipelaneSkill(skillsRoot: string, skillName: string): boolean {
  const targetPath = skillDocPath(skillsRoot, skillName);
  if (!existsSync(targetPath)) {
    return false;
  }

  const content = readFileSync(targetPath, 'utf8');
  return content.includes(PIPELANE_SKILL_MARKER);
}

function loadManagedCodexManifest(skillsRoot: string): ManagedCodexSkillsManifest {
  const fallback = { version: 2, repos: {} } satisfies ManagedCodexSkillsManifest;
  const raw = readJsonFile(managedCodexSkillsPath(skillsRoot), fallback as ManagedCodexSkillsManifest | { skills: string[] });

  if ('repos' in raw && raw.repos && typeof raw.repos === 'object') {
    return {
      version: 2,
      repos: Object.fromEntries(
        Object.entries(raw.repos).map(([repoRoot, skills]) => [repoRoot, Array.isArray(skills) ? skills.filter((entry) => typeof entry === 'string') : []]),
      ),
    };
  }

  return fallback;
}

function loadManagedCodexSkills(skillsRoot: string, manifest: ManagedCodexSkillsManifest): Set<string> {
  const managed = new Set<string>();

  if (existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot)) {
      if (entry === MANAGED_PIPELANE_DIR) {
        continue;
      }

      if (isManagedPipelaneSkill(skillsRoot, entry)) {
        managed.add(entry);
      }
    }
  }

  for (const skills of Object.values(manifest.repos)) {
    for (const entry of skills) {
      if (isManagedPipelaneSkill(skillsRoot, entry)) {
        managed.add(entry);
      }
    }
  }

  return managed;
}

function assertNoCodexSkillCollisions(skillsRoot: string, desiredSkills: Set<string>, managedSkills: Set<string>): void {
  for (const skillName of desiredSkills) {
    const targetDir = path.join(skillsRoot, skillName);
    if (existsSync(targetDir) && !managedSkills.has(skillName)) {
      throw new Error(
        `Codex skill alias collision: ${targetDir} already exists and is not managed by pipelane. Choose a different alias in .pipelane.json or remove the conflicting skill.`,
      );
    }
  }
}

function pruneManagedCodexSkills(skillsRoot: string, desiredSkills: Set<string>, managedSkills: Set<string>): void {
  for (const skillName of managedSkills) {
    if (!desiredSkills.has(skillName) && isManagedPipelaneSkill(skillsRoot, skillName)) {
      rmSync(path.join(skillsRoot, skillName), { recursive: true, force: true });
    }
  }
}

function saveManagedCodexManifest(skillsRoot: string, manifest: ManagedCodexSkillsManifest): void {
  writeJsonFile(managedCodexSkillsPath(skillsRoot), {
    version: 2,
    repos: Object.fromEntries(
      Object.entries(manifest.repos)
        .filter(([, skills]) => skills.length > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([repoRoot, skills]) => [repoRoot, [...new Set(skills)].sort()]),
    ),
  });
}

function desiredCodexSkills(manifest: ManagedCodexSkillsManifest, repoRoot?: string, aliases?: Record<WorkflowCommand, string>): Set<string> {
  if (repoRoot && aliases) {
    manifest.repos[repoRoot] = WORKFLOW_COMMANDS.map((command) => aliasCommandName(aliases[command]));
  }

  const desiredSkills = new Set<string>([INIT_PIPELANE_SKILL_NAME]);
  for (const skills of Object.values(manifest.repos)) {
    for (const skillName of skills) {
      desiredSkills.add(skillName);
    }
  }

  return desiredSkills;
}

export function installCodexWrappers(
  options: { codexHome?: string; repoRoot?: string; aliases?: Partial<Record<WorkflowCommand, string>> | Record<string, string> } = {},
): { codexHome: string; installed: string[] } {
  const codexHome = options.codexHome || homeCodexDir();
  const skillsRoot = path.join(codexHome, 'skills');
  const pipelaneRoot = path.join(skillsRoot, MANAGED_PIPELANE_DIR);
  const binDir = path.join(pipelaneRoot, 'bin');
  const aliases = options.repoRoot ? resolveWorkflowAliases(options.aliases) : null;
  const manifest = loadManagedCodexManifest(skillsRoot);

  installGlobalRuntime(pipelaneRoot, {
    host: 'codex',
    legacyMarkers: [MANAGED_CODEX_SKILLS_FILENAME],
  });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'run-pipelane.sh'), buildRunScript(), { mode: 0o755, encoding: 'utf8' });
  writeFileSync(path.join(binDir, 'bootstrap-pipelane.sh'), buildBootstrapScript(path.join(pipelaneRoot, 'bin', 'pipelane')), { mode: 0o755, encoding: 'utf8' });

  const desiredSkills = desiredCodexSkills(manifest, options.repoRoot, aliases ?? undefined);
  const managedSkills = loadManagedCodexSkills(skillsRoot, manifest);
  assertNoCodexSkillCollisions(skillsRoot, desiredSkills, managedSkills);
  pruneManagedCodexSkills(skillsRoot, desiredSkills, managedSkills);

  const installed: string[] = [];
  for (const skillName of desiredSkills) {
    const skillDir = path.join(skillsRoot, skillName);
    mkdirSync(skillDir, { recursive: true });
    if (skillName === INIT_PIPELANE_SKILL_NAME) {
      writeFileSync(path.join(skillDir, 'SKILL.md'), buildBootstrapSkill(codexHome), 'utf8');
      installed.push(`/${skillName}`);
      continue;
    }

    const slashAlias = `/${skillName}`;
    writeFileSync(path.join(skillDir, 'SKILL.md'), buildSkill(slashAlias, codexHome), 'utf8');
  }

  if (aliases) {
    for (const command of WORKFLOW_COMMANDS) {
      installed.push(aliases[command]);
    }
  }
  saveManagedCodexManifest(skillsRoot, manifest);

  return { codexHome, installed };
}
