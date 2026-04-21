import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { installGlobalRuntime } from './global-runtime.ts';
import { homeCodexDir } from './state.ts';

const LEGACY_WRAPPER_SKILL_MARKER = 'Run the generic pipelane wrapper for this repo.';
const MANAGED_CODEX_SKILLS_FILENAME = 'managed-skills.json';
const MANAGED_PIPELANE_DIR = '.pipelane';
const INIT_PIPELANE_SKILL_NAME = 'init-pipelane';
const PIPELANE_BOOTSTRAP_SKILL_MARKER = '<!-- pipelane:codex-bootstrap:init-pipelane -->';
const LEGACY_BOOTSTRAP_SCRIPT_MARKER = 'bootstrap-pipelane.sh';

function buildBootstrapSkill(codexHome: string): string {
  return `---
name: ${INIT_PIPELANE_SKILL_NAME}
version: 1.0.0
description: Bootstrap the current repo with pipelane.
allowed-tools:
  - Bash
---

${PIPELANE_BOOTSTRAP_SKILL_MARKER}

Run the global pipelane bootstrap for this machine.

1. Parse any arguments that appear after \`/${INIT_PIPELANE_SKILL_NAME}\` in the user's message.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`${codexHome}/skills/${MANAGED_PIPELANE_DIR}/bin/bootstrap-pipelane.sh <parsed arguments>\`
4. Stream the command output directly.
5. After success, tell the user the repo now carries tracked Codex skills in \`.agents/skills\` and they may need to reopen Codex if it was already open.
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

function skillDocPath(skillsRoot: string, skillName: string): string {
  return path.join(skillsRoot, skillName, 'SKILL.md');
}

function isManagedBootstrapSkill(skillsRoot: string, skillName: string): boolean {
  const targetPath = skillDocPath(skillsRoot, skillName);
  if (!existsSync(targetPath)) {
    return false;
  }

  const content = readFileSync(targetPath, 'utf8');
  return content.includes(PIPELANE_BOOTSTRAP_SKILL_MARKER);
}

function isLegacyManagedBootstrapSkill(skillsRoot: string, skillName: string): boolean {
  const targetPath = skillDocPath(skillsRoot, skillName);
  if (!existsSync(targetPath)) {
    return false;
  }

  const content = readFileSync(targetPath, 'utf8');
  return content.includes(LEGACY_WRAPPER_SKILL_MARKER) && content.includes(LEGACY_BOOTSTRAP_SCRIPT_MARKER);
}

function isLegacyManagedWrapperSkill(skillsRoot: string, skillName: string): boolean {
  const targetPath = skillDocPath(skillsRoot, skillName);
  if (!existsSync(targetPath)) {
    return false;
  }

  const content = readFileSync(targetPath, 'utf8');
  return content.includes(LEGACY_WRAPPER_SKILL_MARKER);
}

function pruneLegacyCodexWrappers(skillsRoot: string): string[] {
  if (!existsSync(skillsRoot)) {
    return [];
  }

  const removed: string[] = [];
  for (const entry of readdirSync(skillsRoot)) {
    if (entry === MANAGED_PIPELANE_DIR || entry === INIT_PIPELANE_SKILL_NAME) {
      continue;
    }

    if (isLegacyManagedWrapperSkill(skillsRoot, entry)) {
      rmSync(path.join(skillsRoot, entry), { recursive: true, force: true });
      removed.push(entry);
    }
  }

  const managedSkillsPath = path.join(skillsRoot, MANAGED_PIPELANE_DIR, MANAGED_CODEX_SKILLS_FILENAME);
  if (existsSync(managedSkillsPath)) {
    unlinkSync(managedSkillsPath);
  }

  const legacyRunScriptPath = path.join(skillsRoot, MANAGED_PIPELANE_DIR, 'bin', 'run-pipelane.sh');
  if (existsSync(legacyRunScriptPath)) {
    unlinkSync(legacyRunScriptPath);
  }

  return removed.sort();
}

export function pruneLegacyCodexWrapperSkills(
  options: { codexHome?: string } = {},
): string[] {
  const codexHome = options.codexHome || homeCodexDir();
  return pruneLegacyCodexWrappers(path.join(codexHome, 'skills'));
}

export function installCodexBootstrapSkill(
  options: { codexHome?: string } = {},
): { codexHome: string; installed: string[]; removedLegacySkills: string[] } {
  const codexHome = options.codexHome || homeCodexDir();
  const skillsRoot = path.join(codexHome, 'skills');
  const pipelaneRoot = path.join(skillsRoot, MANAGED_PIPELANE_DIR);
  const binDir = path.join(pipelaneRoot, 'bin');
  const bootstrapSkillDir = path.join(skillsRoot, INIT_PIPELANE_SKILL_NAME);

  mkdirSync(skillsRoot, { recursive: true });
  if (
    existsSync(bootstrapSkillDir)
    && !isManagedBootstrapSkill(skillsRoot, INIT_PIPELANE_SKILL_NAME)
    && !isLegacyManagedBootstrapSkill(skillsRoot, INIT_PIPELANE_SKILL_NAME)
  ) {
    throw new Error(
      `Codex skill alias collision: ${bootstrapSkillDir} already exists and is not managed by pipelane. Remove or rename the conflicting skill.`,
    );
  }

  installGlobalRuntime(pipelaneRoot, {
    host: 'codex',
    legacyMarkers: [MANAGED_CODEX_SKILLS_FILENAME],
  });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'bootstrap-pipelane.sh'), buildBootstrapScript(path.join(pipelaneRoot, 'bin', 'pipelane')), { mode: 0o755, encoding: 'utf8' });

  const removedLegacySkills = pruneLegacyCodexWrappers(skillsRoot);

  mkdirSync(bootstrapSkillDir, { recursive: true });
  writeFileSync(path.join(bootstrapSkillDir, 'SKILL.md'), buildBootstrapSkill(codexHome), 'utf8');

  return {
    codexHome,
    installed: [`/${INIT_PIPELANE_SKILL_NAME}`],
    removedLegacySkills,
  };
}
