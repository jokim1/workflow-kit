import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

import {
  buildDestinationPlanForCommand,
  canonicalizeDestinationFingerprint,
  type DestinationMilestone,
  type DestinationPlan,
  type DestinationStep,
} from './destination-planner.ts';
import type { ParsedOperatorArgs } from './state.ts';

export const DESTINATION_INTERNAL_STEP_ENV = 'PIPELANE_DESTINATION_INTERNAL_STEP';
export const DESTINATION_APPROVED_ROUTE_FINGERPRINT_ENV = 'PIPELANE_DESTINATION_APPROVED_ROUTE_FINGERPRINT';
export const DESTINATION_ROUTE_PROD_CONFIRMED_ENV = 'PIPELANE_DESTINATION_ROUTE_PROD_CONFIRMED';
export const DESTINATION_APPROVED_TARGET_SHA_ENV = 'PIPELANE_DESTINATION_APPROVED_TARGET_SHA';

export interface DestinationRouteStepExecution {
  id: DestinationStep['id'];
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DestinationRouteExecution {
  completed: boolean;
  failedStep: string | null;
  failureMessage?: string;
  steps: DestinationRouteStepExecution[];
}

export async function confirmDestinationRoute(plan: DestinationPlan, parsed: ParsedOperatorArgs): Promise<boolean> {
  if (parsed.flags.yes) return true;
  if (parsed.flags.plan) return false;
  if (!process.stdin.isTTY) return false;

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question('Type Y to continue: (Y/n) ')).trim().toLowerCase();
    return answer === '' || answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export function nonTtyConfirmationMessage(plan: DestinationPlan): string {
  return [
    `${plan.targetCommand} needs confirmation before running:`,
    `  ${plan.remainingSteps.map((step) => step.command).join(' -> ')}`,
    '',
    'Re-run from a TTY, pass --yes, or use the API confirm-token flow.',
  ].join('\n');
}

export function executeDestinationRoute(cwd: string, parsed: ParsedOperatorArgs, plan: DestinationPlan): DestinationRouteExecution {
  const execution: DestinationRouteExecution = {
    completed: true,
    failedStep: null,
    steps: [],
  };
  const captureOutput = parsed.flags.json;
  let currentPlan = replanDestination(cwd, parsed);
  const initialDrift = routeApprovalDrift(plan, currentPlan);
  if (initialDrift) {
    return failRouteGuard(execution, nextExecutableStep(currentPlan)?.command ?? plan.targetCommand, initialDrift);
  }

  while (true) {
    const step = nextExecutableStep(currentPlan);
    if (!step) return execution;

    const stepBlocker = validateStepStart(plan, currentPlan, step);
    if (stepBlocker) {
      return failRouteGuard(execution, step.command, stepBlocker);
    }

    const args = buildStepArgs(step, parsed, currentPlan);
    const result = spawnSync(process.execPath, [cliPath(), 'run', ...args], {
      cwd,
      env: buildStepEnv(step, currentPlan),
      encoding: 'utf8',
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : ['inherit', 'inherit', 'inherit'],
    });
    const exitCode = result.status ?? 1;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';

    execution.steps.push({
      id: step.id,
      command: step.command,
      exitCode,
      stdout,
      stderr,
    });

    if (exitCode !== 0) {
      execution.completed = false;
      execution.failedStep = step.command;
      return execution;
    }

    const nextPlan = replanDestination(cwd, parsed);
    const progressBlocker = validateStepProgress(plan, currentPlan, nextPlan, step);
    if (progressBlocker) {
      return failRouteGuard(execution, step.command, progressBlocker);
    }
    currentPlan = nextPlan;
  }
}

function buildStepEnv(step: DestinationStep, plan: DestinationPlan): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [DESTINATION_INTERNAL_STEP_ENV]: '1',
  };
  delete env.PIPELANE_DEPLOY_PROD_API_CONFIRMED;
  delete env[DESTINATION_ROUTE_PROD_CONFIRMED_ENV];
  delete env[DESTINATION_APPROVED_TARGET_SHA_ENV];
  if (step.id === 'deploy_prod' && process.env[DESTINATION_ROUTE_PROD_CONFIRMED_ENV] === '1') {
    env.PIPELANE_DEPLOY_PROD_API_CONFIRMED = '1';
  }
  if ((step.id === 'deploy_staging' || step.id === 'deploy_prod') && plan.mode === 'build') {
    const fp = routeFingerprint(plan);
    if (typeof fp.targetSha === 'string' && fp.targetSha.trim()) {
      env[DESTINATION_APPROVED_TARGET_SHA_ENV] = fp.targetSha.trim();
    }
  }
  return env;
}

function replanDestination(cwd: string, parsed: ParsedOperatorArgs): DestinationPlan {
  const plan = buildDestinationPlanForCommand(cwd, parsed);
  if (!plan) {
    throw new Error('destination route could not be re-planned for the requested command.');
  }
  return plan;
}

function nextExecutableStep(plan: DestinationPlan): DestinationStep | null {
  return plan.remainingSteps.find((step) => step.id !== 'review_gate') ?? null;
}

function failRouteGuard(
  execution: DestinationRouteExecution,
  failedStep: string,
  message: string,
): DestinationRouteExecution {
  execution.completed = false;
  execution.failedStep = failedStep;
  execution.failureMessage = message;
  return execution;
}

function routeApprovalDrift(approved: DestinationPlan, current: DestinationPlan): string {
  if (
    canonicalizeDestinationFingerprint(approved.fingerprintInputs)
    === canonicalizeDestinationFingerprint(current.fingerprintInputs)
  ) {
    return '';
  }
  return 'destination route changed after confirmation. Re-run the destination command so the route, surfaces, PR, SHA, and worktree changes are approved together.';
}

function validateStepStart(approved: DestinationPlan, current: DestinationPlan, step: DestinationStep): string {
  const staticDrift = routeStaticDrift(approved, current);
  if (staticDrift) return staticDrift;
  if (current.blockers.length > 0) {
    return `destination route is blocked after re-planning: ${current.blockers.join('; ')}`;
  }
  if (step.id !== 'pr' && currentWorktree(current).dirty) {
    return 'destination route stopped because the worktree has uncommitted changes after confirmation. Re-run the destination command to approve the current diff.';
  }
  return '';
}

function validateStepProgress(
  approved: DestinationPlan,
  before: DestinationPlan,
  after: DestinationPlan,
  step: DestinationStep,
): string {
  const beforeFp = routeFingerprint(before);
  const afterFp = routeFingerprint(after);
  if (beforeFp.explicitDeploySha && afterFp.targetSha !== beforeFp.targetSha) {
    return 'destination route stopped because the explicit deploy target SHA changed after approval. Re-run the destination command with a stable SHA.';
  }

  const staticDrift = routeStaticDrift(approved, after);
  if (staticDrift) return staticDrift;
  if (after.blockers.length > 0) {
    return `destination route is blocked after ${step.command}: ${after.blockers.join('; ')}`;
  }

  const milestoneDelta = destinationMilestoneRank(after.currentMilestone)
    - destinationMilestoneRank(before.currentMilestone);
  if (milestoneDelta < 0) {
    return `${step.command} completed but the destination route moved backward from ${before.currentMilestone} to ${after.currentMilestone}. Re-run the destination command after checking the step output.`;
  }

  const afterExecutable = executableStepIds(after);
  if (milestoneDelta === 0 && afterExecutable.includes(step.id)) {
    return `${step.command} completed but the destination route made no observable progress. Re-run the destination command after checking the step output.`;
  }

  if (step.id !== 'pr' && afterFp.headSha !== beforeFp.headSha) {
    return 'destination route stopped because HEAD changed outside the PR creation step. Re-run the destination command to approve the new SHA.';
  }
  if (step.id !== 'pr' && afterFp.prNumber !== beforeFp.prNumber) {
    return 'destination route stopped because the PR target changed outside the PR creation step. Re-run the destination command to approve the current PR.';
  }
  if (step.id !== 'merge' && afterFp.mergedSha !== beforeFp.mergedSha) {
    return 'destination route stopped because the merge SHA changed outside the merge step. Re-run the destination command to approve the current SHA.';
  }
  if (step.id !== 'pr' && step.id !== 'merge' && afterFp.targetSha !== beforeFp.targetSha) {
    return 'destination route stopped because the deploy target SHA changed outside PR or merge progress. Re-run the destination command to approve the current SHA.';
  }

  return '';
}

function executableStepIds(plan: DestinationPlan): Array<DestinationStep['id']> {
  return plan.remainingSteps
    .filter((entry) => entry.id !== 'review_gate')
    .map((entry) => entry.id);
}

function destinationMilestoneRank(milestone: DestinationMilestone): number {
  switch (milestone) {
    case 'local_dirty': return 0;
    case 'pr_open': return 1;
    case 'merged': return 2;
    case 'staging_deployed': return 3;
    case 'staging_smoked': return 4;
    case 'prod_deployed': return 5;
  }
}

function routeStaticDrift(approved: DestinationPlan, current: DestinationPlan): string {
  if (
    canonicalizeDestinationFingerprint(routeStaticFingerprint(approved))
    === canonicalizeDestinationFingerprint(routeStaticFingerprint(current))
  ) {
    return '';
  }
  return 'destination route target changed during execution. Re-run the destination command to approve the current task, mode, surfaces, smoke settings, and deploy configuration.';
}

function routeStaticFingerprint(plan: DestinationPlan): Record<string, unknown> {
  const fp = routeFingerprint(plan);
  return {
    taskSlug: fp.taskSlug,
    mode: fp.mode,
    target: fp.target,
    explicitDeploySha: fp.explicitDeploySha,
    surfaces: fp.surfaces,
    smoke: {
      requireStagingSmoke: fp.smoke.requireStagingSmoke,
      stagingConfigured: fp.smoke.stagingConfigured,
    },
    targetSha: fp.explicitDeploySha ? fp.targetSha : undefined,
    deployConfigFingerprints: fp.deployConfigFingerprints,
  };
}

function routeFingerprint(plan: DestinationPlan): {
  taskSlug: string;
  mode: string;
  target: string;
  prNumber: unknown;
  headSha: unknown;
  mergedSha: unknown;
  targetSha: unknown;
  explicitDeploySha: unknown;
  surfaces: unknown;
  smoke: { requireStagingSmoke?: unknown; stagingConfigured?: unknown; qualifyingRunId?: unknown };
  deployConfigFingerprints: unknown;
} {
  const fp = plan.fingerprintInputs as {
    taskSlug?: string;
    mode?: string;
    target?: string;
    prNumber?: unknown;
    headSha?: unknown;
    mergedSha?: unknown;
    targetSha?: unknown;
    explicitDeploySha?: unknown;
    surfaces?: unknown;
    smoke?: { requireStagingSmoke?: unknown; stagingConfigured?: unknown; qualifyingRunId?: unknown };
    deployConfigFingerprints?: unknown;
  };
  return {
    taskSlug: fp.taskSlug ?? '',
    mode: fp.mode ?? '',
    target: fp.target ?? '',
    prNumber: fp.prNumber,
    headSha: fp.headSha,
    mergedSha: fp.mergedSha,
    targetSha: fp.targetSha,
    explicitDeploySha: fp.explicitDeploySha,
    surfaces: fp.surfaces,
    smoke: fp.smoke ?? {},
    deployConfigFingerprints: fp.deployConfigFingerprints,
  };
}

function currentWorktree(plan: DestinationPlan): { dirty: boolean } {
  const fp = plan.fingerprintInputs as { worktree?: { dirty?: unknown } };
  return { dirty: fp.worktree?.dirty === true };
}

function buildStepArgs(step: DestinationStep, parsed: ParsedOperatorArgs, plan: DestinationPlan): string[] {
  const args: string[] = [];
  const pushOpt = (flag: string, value: string) => {
    if (value.trim()) args.push(flag, value);
  };
  const pushSurfaces = () => {
    if (plan.requestedSurfaces.length > 0) args.push('--surfaces', plan.requestedSurfaces.join(','));
  };
  const pushTaskOrPr = () => {
    if (parsed.flags.pr.trim()) {
      pushOpt('--pr', parsed.flags.pr);
      return;
    }
    pushOpt('--task', parsed.flags.task || plan.taskSlug);
  };
  const pushApprovedDeploySha = () => {
    if (!parsed.flags.sha.trim()) return;
    const fp = routeFingerprint(plan);
    if (typeof fp.targetSha === 'string' && fp.targetSha.trim()) {
      args.push('--sha', fp.targetSha);
      return;
    }
    pushOpt('--sha', parsed.flags.sha);
  };
  const pushRouteTargetSha = () => {
    const fp = routeFingerprint(plan);
    if (typeof fp.targetSha === 'string' && fp.targetSha.trim()) {
      args.push('--sha', fp.targetSha);
    }
  };
  if (step.id === 'pr') {
    args.push('pr');
    pushOpt('--task', parsed.flags.task || plan.taskSlug);
    pushOpt('--title', parsed.flags.title || plan.taskSlug);
    pushOpt('--message', parsed.flags.message);
    for (const force of parsed.flags.forceInclude) args.push('--force-include', force);
    return args;
  }
  if (step.id === 'merge') {
    args.push('merge');
    pushTaskOrPr();
    return args;
  }
  if (step.id === 'deploy_staging') {
    args.push('deploy', 'staging');
    pushTaskOrPr();
    pushApprovedDeploySha();
    pushSurfaces();
    return args;
  }
  if (step.id === 'smoke_staging') {
    args.push('smoke', 'staging');
    pushTaskOrPr();
    pushRouteTargetSha();
    pushSurfaces();
    return args;
  }
  if (step.id === 'deploy_prod') {
    args.push('deploy', 'prod');
    pushTaskOrPr();
    pushApprovedDeploySha();
    pushSurfaces();
    if (parsed.flags.skipSmokeCoverage) args.push('--skip-smoke-coverage');
    pushOpt('--reason', parsed.flags.reason);
    return args;
  }
  return args;
}

function cliPath(): string {
  const here = fileURLToPath(import.meta.url);
  const kitRoot = path.resolve(path.dirname(here), '..', '..');
  const srcCli = path.join(kitRoot, 'src', 'cli.ts');
  if (here.includes(`${path.sep}src${path.sep}`)) return srcCli;
  const distCli = path.join(kitRoot, 'dist', 'cli.js');
  if (existsSync(distCli)) return distCli;
  return srcCli;
}
