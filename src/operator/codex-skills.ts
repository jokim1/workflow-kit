import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { aliasCommandName, readJsonFile, resolveWorkflowAliases, type WorkflowCommand, WORKFLOW_COMMANDS, type WorkflowConfig, writeJsonFile } from './state.ts';

const MANAGED_CODEX_SKILLS_FILENAME = '.pipelane-managed.json';
const INIT_PIPELANE_SKILL_NAME = 'init-pipelane';
const PIPELANE_CODEX_SKILL_MARKER = '<!-- pipelane:codex-skill:';

function buildSkill(command: WorkflowCommand, slashAlias: string): string {
  const skillName = aliasCommandName(slashAlias);
  return `---
name: ${skillName}
version: 1.0.0
description: Run the pipelane command currently mapped to ${slashAlias} in this repo.
allowed-tools:
  - Bash
---
${PIPELANE_CODEX_SKILL_MARKER}${command} -->

Run the repo-native pipelane command currently mapped to ${slashAlias}.

1. Parse any arguments that appear after the requested command invocation.
2. Preserve quoted substrings when building the shell command.
3. Run:
   \`npm run pipelane:${command} -- <parsed arguments>\`
4. Stream the command output directly.
`;
}

function managedCodexSkillsPath(skillsRoot: string): string {
  return path.join(skillsRoot, MANAGED_CODEX_SKILLS_FILENAME);
}

function skillDocPath(skillsRoot: string, skillName: string): string {
  return path.join(skillsRoot, skillName, 'SKILL.md');
}

function isManagedCodexSkill(skillsRoot: string, skillName: string): boolean {
  const targetPath = skillDocPath(skillsRoot, skillName);
  if (!existsSync(targetPath)) {
    return false;
  }

  const content = readFileSync(targetPath, 'utf8');
  return content.includes(PIPELANE_CODEX_SKILL_MARKER);
}

function loadManagedCodexSkills(skillsRoot: string): Set<string> {
  const managed = new Set<string>();
  const manifest = readJsonFile(managedCodexSkillsPath(skillsRoot), { skills: [] as string[] });

  if (!existsSync(skillsRoot)) {
    return managed;
  }

  for (const entry of manifest.skills) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      continue;
    }

    if (isManagedCodexSkill(skillsRoot, entry)) {
      managed.add(entry);
    }
  }

  for (const entry of readdirSync(skillsRoot)) {
    if (entry.startsWith('.')) {
      continue;
    }

    if (isManagedCodexSkill(skillsRoot, entry)) {
      managed.add(entry);
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
    if (!desiredSkills.has(skillName) && isManagedCodexSkill(skillsRoot, skillName)) {
      rmSync(path.join(skillsRoot, skillName), { recursive: true, force: true });
    }
  }
}

function saveManagedCodexSkills(skillsRoot: string, desiredSkills: Set<string>): void {
  writeJsonFile(managedCodexSkillsPath(skillsRoot), {
    skills: [...desiredSkills].sort(),
  });
}

export function syncCodexSkills(
  repoRoot: string,
  config: WorkflowConfig,
): { skillsDir: string; installed: string[] } {
  const skillsRoot = path.join(repoRoot, '.agents', 'skills');
  mkdirSync(skillsRoot, { recursive: true });

  const aliases = resolveWorkflowAliases(config.aliases);
  const desiredSkills = new Set<string>();
  const desiredMappings = new Map<string, { command: WorkflowCommand; slashAlias: string }>();

  for (const command of WORKFLOW_COMMANDS) {
    const slashAlias = aliases[command];
    const skillName = aliasCommandName(slashAlias);
    if (skillName === INIT_PIPELANE_SKILL_NAME) {
      throw new Error(
        `Workflow aliases must stay distinct from the reserved Codex bootstrap skill. ${command} resolves to ${slashAlias}, which conflicts with ${INIT_PIPELANE_SKILL_NAME}.`,
      );
    }
    desiredSkills.add(skillName);
    desiredMappings.set(skillName, { command, slashAlias });
  }

  const managedSkills = loadManagedCodexSkills(skillsRoot);
  assertNoCodexSkillCollisions(skillsRoot, desiredSkills, managedSkills);
  pruneManagedCodexSkills(skillsRoot, desiredSkills, managedSkills);

  for (const [skillName, mapping] of desiredMappings.entries()) {
    const skillDir = path.join(skillsRoot, skillName);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillDocPath(skillsRoot, skillName), buildSkill(mapping.command, mapping.slashAlias), 'utf8');
  }

  saveManagedCodexSkills(skillsRoot, desiredSkills);

  return {
    skillsDir: skillsRoot,
    installed: WORKFLOW_COMMANDS.map((command) => aliases[command]),
  };
}
