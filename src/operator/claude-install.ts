import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { installGlobalRuntime } from './global-runtime.ts';
import { homeClaudeDir } from './state.ts';

const MANAGED_CLAUDE_RUNTIME_DIR = 'pipelane';
const INIT_PIPELANE_SKILL_NAME = 'init-pipelane';
const PIPELANE_CLAUDE_SKILL_MARKER = '<!-- pipelane:claude-skill:init-pipelane -->';

function buildBootstrapScript(runtimeRoot: string): string {
  return `#!/bin/sh
set -eu

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$repo_root"
exec "${path.join(runtimeRoot, 'bin', 'pipelane')}" bootstrap "$@"
`;
}

function buildBootstrapSkill(claudeHome: string): string {
  return `---
name: ${INIT_PIPELANE_SKILL_NAME}
version: 1.0.0
description: Bootstrap the current repo with pipelane. Use when asked to initialize pipelane, set up pipelane, or enable pipelane in this repo.
allowed-tools:
  - Bash
triggers:
  - init pipelane
  - initialize pipelane
  - set up pipelane
---
${PIPELANE_CLAUDE_SKILL_MARKER}

Run the global pipelane bootstrap for this machine.

1. Parse any arguments that appear after \`/${INIT_PIPELANE_SKILL_NAME}\` in the user's message.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`${path.join(claudeHome, 'skills', MANAGED_CLAUDE_RUNTIME_DIR, 'bin', 'bootstrap-pipelane.sh')} <parsed arguments>\`
4. Stream the command output directly.
5. After success, tell the user the repo-local Claude commands were installed and they may need to reopen Claude if they were already inside the repo.
`;
}

function skillDocPath(skillDir: string): string {
  return path.join(skillDir, 'SKILL.md');
}

function isManagedClaudeSkillDir(skillDir: string): boolean {
  const targetPath = skillDocPath(skillDir);
  if (!existsSync(targetPath)) {
    return false;
  }

  const content = readFileSync(targetPath, 'utf8');
  return content.includes(PIPELANE_CLAUDE_SKILL_MARKER);
}

export function installClaudeBootstrapSkill(
  options: { claudeHome?: string } = {},
): { claudeHome: string; runtimeRoot: string; installed: string[] } {
  const claudeHome = options.claudeHome || homeClaudeDir();
  const skillsRoot = path.join(claudeHome, 'skills');
  const runtimeRoot = path.join(skillsRoot, MANAGED_CLAUDE_RUNTIME_DIR);
  const publicSkillDir = path.join(skillsRoot, INIT_PIPELANE_SKILL_NAME);
  const publicSkillPath = skillDocPath(publicSkillDir);
  const canonicalSkillDir = path.join(runtimeRoot, INIT_PIPELANE_SKILL_NAME);
  const canonicalSkillPath = skillDocPath(canonicalSkillDir);

  mkdirSync(skillsRoot, { recursive: true });
  if (existsSync(publicSkillDir) && !isManagedClaudeSkillDir(publicSkillDir)) {
    throw new Error(
      `Claude skill alias collision: ${publicSkillDir} already exists and is not managed by pipelane. Remove or rename the conflicting skill.`,
    );
  }

  installGlobalRuntime(runtimeRoot, { host: 'claude' });
  mkdirSync(path.join(runtimeRoot, 'bin'), { recursive: true });
  writeFileSync(path.join(runtimeRoot, 'bin', 'bootstrap-pipelane.sh'), buildBootstrapScript(runtimeRoot), { mode: 0o755, encoding: 'utf8' });
  mkdirSync(canonicalSkillDir, { recursive: true });
  writeFileSync(canonicalSkillPath, buildBootstrapSkill(claudeHome), 'utf8');

  rmSync(publicSkillDir, { recursive: true, force: true });
  mkdirSync(publicSkillDir, { recursive: true });
  symlinkSync(canonicalSkillPath, publicSkillPath);

  return {
    claudeHome,
    runtimeRoot,
    installed: [`/${INIT_PIPELANE_SKILL_NAME}`],
  };
}
