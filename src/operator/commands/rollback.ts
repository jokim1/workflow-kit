import {
  computeDeployConfigFingerprint,
  emptyDeployConfig,
  loadDeployConfig,
  normalizeDeployEnvironment,
  resolveDeployStateKey,
  signDeployRecord,
  verifyDeployRecord,
} from '../release-gate.ts';
import {
  loadDeployState,
  loadPrRecord,
  nowIso,
  printResult,
  resolveWorkflowContext,
  runGh,
  runGit,
  type DeployRecord,
  type DeployStatus,
  type DeployVerification,
  type ParsedOperatorArgs,
} from '../state.ts';
import {
  findLastGoodDeploy,
  inferActiveTaskLock,
  makeIdempotencyKey,
  resolveCommandSurfaces,
  resolveSurfaceHealthcheckUrl,
  setNextAction,
} from './helpers.ts';
import {
  findRecentRun,
  persistRecord,
  probeHealthcheck,
  requireProdConfirmation,
  resolveTriggeredBy,
  watchWorkflowRun,
} from './deploy.ts';

// v1.1: `/rollback <env>` dispatches a NEW deploy of the last-known-good
// sha for the named environment + surfaces. It is NOT a revert of the
// failing deploy — the gh workflow still runs, a healthcheck still
// probes, and a new DeployRecord is persisted with `rollbackOfSha`
// pointing at the failing sha.
//
// `--revert-pr` (release-mode only) is an orthogonal recovery path: it
// opens a `git revert <mergeCommit>` PR via `gh pr create`. No deploy
// is dispatched, no sha is touched on the main branch directly.
export async function handleRollback(cwd: string, parsed: ParsedOperatorArgs): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  const environment = normalizeDeployEnvironment(parsed.positional[0] ?? '');
  const explicitSurfaces = [...parsed.flags.surfaces, ...parsed.positional.slice(1)];
  const { taskSlug, lock } = inferActiveTaskLock(context, parsed.flags.task);
  const surfaces = resolveCommandSurfaces(context, explicitSurfaces, lock.surfaces);

  if (parsed.flags.revertPr) {
    await handleRevertPr(cwd, parsed, { taskSlug });
    return;
  }

  const deployConfig = loadDeployConfig(context.repoRoot) ?? emptyDeployConfig();
  const deployState = loadDeployState(context.commonDir, context.config);
  const stateKey = resolveDeployStateKey();
  const trustedRecords = stateKey
    ? deployState.records.filter((record) => verifyDeployRecord(record, stateKey))
    : deployState.records;

  // Resolve the sha we're rolling back FROM. Walk newest-first for a
  // matching env+surfaces record regardless of status — a failing deploy
  // is the expected input for rollback, so status:'failed' is fine.
  const currentRecord = findLatestRecord({
    records: trustedRecords,
    environment,
    surfaces,
  });
  if (!currentRecord) {
    throw new Error([
      `rollback ${environment} blocked: no prior DeployRecord exists for surfaces ${surfaces.join(',')}.`,
      `Deploy to ${environment} at least once before attempting rollback.`,
    ].join('\n'));
  }

  const target = findLastGoodDeploy({
    records: trustedRecords,
    environment,
    surfaces,
    excludeSha: currentRecord.sha,
  });
  if (!target) {
    throw new Error([
      `rollback ${environment} blocked: no earlier succeeded+verified deploy exists for surfaces ${surfaces.join(',')}`,
      `prior to the current sha ${currentRecord.sha.slice(0, 7)}.`,
      '`--revert-pr` or a fresh redeploy are the only paths forward.',
    ].join('\n'));
  }

  if (target.sha === currentRecord.sha) {
    // Belt-and-suspenders: findLastGoodDeploy already excludes the
    // current sha, but a deliberately-identical idempotency key (same
    // sha, different timestamp) could theoretically slip through. Abort
    // rather than dispatch a rollback that's a no-op.
    throw new Error([
      `rollback ${environment} is a no-op: target sha matches current sha ${target.sha.slice(0, 7)}.`,
      'Nothing earlier to roll back to.',
    ].join('\n'));
  }

  // Prod rollbacks join the risky set — same typed-SHA prefix gate as
  // deploy.prod. Confirms on the TARGET sha (what's about to become
  // production), not the failing sha. API path bypasses via
  // PIPELANE_DEPLOY_PROD_API_CONFIRMED after consuming an HMAC token.
  if (environment === 'prod' && context.modeState.mode === 'release') {
    await requireProdConfirmation(target.sha);
  }

  const workflowName = environment === 'staging'
    ? (deployConfig.frontend.staging.deployWorkflow || context.config.deployWorkflowName)
    : (deployConfig.frontend.production.deployWorkflow || context.config.deployWorkflowName);

  const requestedAt = nowIso();
  const triggeredBy = resolveTriggeredBy();
  const dispatchStart = Date.now();
  const configFingerprint = computeDeployConfigFingerprint(deployConfig, environment);

  // Fresh idempotency key scoped to (rollback target + current failure +
  // surfaces + task). Distinct from a plain re-deploy of the same sha,
  // so a rollback can't short-circuit against a pre-existing succeeded
  // record for the target sha (which would skip the dispatch we need
  // to replace the broken revision in the environment).
  const idempotencyKey = makeIdempotencyKey({
    environment,
    sha: target.sha,
    surfaces,
    taskSlug,
    configFingerprint: `${configFingerprint}:rollback-from:${currentRecord.sha}`,
  });

  runGh(context.repoRoot, [
    'workflow',
    'run',
    workflowName,
    '-f',
    `environment=${environment === 'prod' ? 'production' : 'staging'}`,
    '-f',
    `sha=${target.sha}`,
    '-f',
    `surfaces=${surfaces.join(',')}`,
  ]);

  const run = findRecentRun(context.repoRoot, workflowName, target.sha, dispatchStart);

  let record: DeployRecord = {
    environment,
    sha: target.sha,
    surfaces,
    workflowName,
    requestedAt,
    taskSlug,
    status: 'requested',
    workflowRunId: run?.id,
    workflowRunUrl: run?.url,
    idempotencyKey,
    triggeredBy,
    rollbackOfSha: currentRecord.sha,
  };

  persistRecord(context.commonDir, context.config, deployState.records, record);

  if (parsed.flags.async) {
    printResult(parsed.flags, {
      ...record,
      message: [
        `Rollback dispatched (async): ${environment}`,
        `Task: ${taskSlug}`,
        `From: ${currentRecord.sha.slice(0, 7)} (current)`,
        `To:   ${target.sha.slice(0, 7)} (${target.verifiedAt ? `verified ${target.verifiedAt}` : 'last-good'})`,
        `Surfaces: ${surfaces.join(', ')}`,
        `Workflow: ${workflowName}`,
        run?.id ? `Workflow run: ${run.url ?? run.id}` : 'Workflow run: not yet resolvable',
        'Exit without watching per --async.',
      ].filter(Boolean).join('\n'),
    });
    return;
  }

  // Watch + probe. The verification logic mirrors deploy.ts so the
  // rollback record carries the same per-surface verification shape
  // the release gate + dashboard already consume.
  const watched = watchWorkflowRun(context.repoRoot, run?.id);
  const finishedAt = nowIso();
  const durationMs = Date.now() - dispatchStart;
  let status: DeployStatus = watched.ok ? 'succeeded' : 'failed';
  let failureReason = watched.ok ? undefined : (watched.reason || 'workflow run reported non-zero exit');

  let verification: DeployVerification | undefined;
  let verificationBySurface: Record<string, DeployVerification> | undefined;
  if (watched.ok) {
    verificationBySurface = {};
    const perSurfaceFailures: string[] = [];
    const stubStatus = process.env.PIPELANE_DEPLOY_HEALTHCHECK_STUB_STATUS;
    for (const surface of surfaces) {
      const surfaceUrl = resolveSurfaceHealthcheckUrl(deployConfig, environment, surface);
      if (!surfaceUrl && !stubStatus) {
        const empty: DeployVerification = { healthcheckUrl: '', probes: 0 };
        verificationBySurface[surface] = empty;
        perSurfaceFailures.push(`${surface}: no healthcheck URL configured`);
        continue;
      }
      const probe = await probeHealthcheck(surfaceUrl);
      verificationBySurface[surface] = probe;
      const code = probe.statusCode;
      if (typeof code !== 'number' || code < 200 || code >= 300) {
        perSurfaceFailures.push(
          probe.error
            ?? (code
              ? `${surface}: healthcheck returned HTTP ${code}`
              : `${surface}: healthcheck did not return a 2xx`),
        );
      }
    }
    verification = verificationBySurface['frontend']
      ?? verificationBySurface[surfaces[0]]
      ?? { healthcheckUrl: '', probes: 0 };
    if (perSurfaceFailures.length > 0) {
      status = 'failed';
      failureReason = perSurfaceFailures.join('; ');
    }
  }

  const verifiedAt = status === 'succeeded' ? nowIso() : undefined;

  record = {
    ...record,
    status,
    finishedAt,
    durationMs,
    verification,
    verificationBySurface,
    verifiedAt,
    configFingerprint,
    failureReason,
  };
  if (stateKey) {
    record = { ...record, signature: signDeployRecord(record, stateKey) };
  }

  const latestState = loadDeployState(context.commonDir, context.config);
  persistRecord(context.commonDir, context.config, latestState.records, record);

  if (status !== 'succeeded') {
    throw new Error([
      `Rollback did not verify: ${environment}`,
      failureReason ?? 'unknown failure',
      run?.url ? `Workflow: ${run.url}` : '',
    ].filter(Boolean).join('\n'));
  }

  setNextAction(
    context.commonDir,
    context.config,
    taskSlug,
    `${environment} rolled back to ${target.sha.slice(0, 7)} from ${currentRecord.sha.slice(0, 7)}`,
  );

  printResult(parsed.flags, {
    ...record,
    message: [
      `Rollback verified: ${environment}`,
      `Task: ${taskSlug}`,
      `From: ${currentRecord.sha}`,
      `To:   ${target.sha}`,
      `Surfaces: ${surfaces.join(', ')}`,
      `Workflow: ${workflowName}`,
      run?.url ? `Workflow run: ${run.url}` : '',
      verification?.healthcheckUrl
        ? `Healthcheck: ${verification.healthcheckUrl} → HTTP ${verification.statusCode} in ${verification.latencyMs}ms (${verification.probes} probe(s))`
        : 'Healthcheck: skipped (no URL configured)',
      environment === 'prod'
        ? 'Next: investigate the failing change and open a revert PR if needed (workflow:rollback -- prod --revert-pr).'
        : 'Next: validate staging, then decide whether to promote to prod or open a revert PR.',
    ].filter(Boolean).join('\n'),
  });
}

// v1.1: `--revert-pr` opens a git-revert PR instead of dispatching a
// deploy. Release-mode only — build-mode operators are already free to
// edit main directly, and the safety value here is keeping a paper
// trail through PR review. Never force-pushes, never touches main.
async function handleRevertPr(
  cwd: string,
  parsed: ParsedOperatorArgs,
  options: { taskSlug: string },
): Promise<void> {
  const context = resolveWorkflowContext(cwd);
  if (context.modeState.mode !== 'release') {
    throw new Error('--revert-pr is release-mode only. Switch modes with workflow:devmode -- release first.');
  }

  const prRecord = loadPrRecord(context.commonDir, context.config, options.taskSlug);
  const mergedSha = prRecord?.mergedSha ?? resolveLastMergedShaFromGit(context.repoRoot, context.config.baseBranch);
  if (!mergedSha) {
    throw new Error([
      '--revert-pr blocked: could not resolve a merge commit to revert.',
      'Pass --sha <mergeCommit> explicitly, or ensure pr-state.json has a recorded mergedSha for this task.',
    ].join('\n'));
  }

  const revertShortSha = mergedSha.slice(0, 7);
  const revertBranch = `${context.config.branchPrefix}revert-${revertShortSha}`;

  // Refuse to reuse an existing branch — operators re-running /rollback
  // --revert-pr need deterministic behavior, not a silent append to a
  // pre-existing revert branch.
  if (runGit(context.repoRoot, ['rev-parse', '--verify', revertBranch], true)) {
    throw new Error(`--revert-pr blocked: branch ${revertBranch} already exists. Delete it or pass a different --sha.`);
  }

  runGit(context.repoRoot, ['fetch', 'origin', context.config.baseBranch], true);
  const baseRef = runGit(context.repoRoot, ['rev-parse', '--verify', `origin/${context.config.baseBranch}`], true)
    ?? runGit(context.repoRoot, ['rev-parse', '--verify', context.config.baseBranch], true);
  if (!baseRef) {
    throw new Error(`--revert-pr blocked: cannot resolve base branch "${context.config.baseBranch}" locally or on origin.`);
  }

  runGit(context.repoRoot, ['switch', '-c', revertBranch, baseRef]);
  // --no-edit keeps this non-interactive. --no-commit + follow-up commit
  // would let us customize the message more thoroughly, but the default
  // `Revert "<subject>"` message is universally parseable.
  const revertResult = runGit(context.repoRoot, ['revert', '--no-edit', mergedSha], true);
  if (revertResult === null) {
    runGit(context.repoRoot, ['revert', '--abort'], true);
    runGit(context.repoRoot, ['switch', context.config.baseBranch], true);
    runGit(context.repoRoot, ['branch', '-D', revertBranch], true);
    throw new Error([
      `--revert-pr blocked: \`git revert ${revertShortSha}\` failed (likely a merge conflict).`,
      'Resolve manually: check out the branch, run git revert, commit, and open the PR by hand.',
    ].join('\n'));
  }

  runGit(context.repoRoot, ['push', '-u', 'origin', revertBranch]);
  const prUrl = runGh(context.repoRoot, [
    'pr',
    'create',
    '--base',
    context.config.baseBranch,
    '--head',
    revertBranch,
    '--title',
    `Revert "${revertShortSha}"`,
    '--body',
    [
      `Automated revert of ${mergedSha} created via \`/rollback --revert-pr\`.`,
      'Review the revert carefully before merging — this undoes the above commit.',
    ].join('\n\n'),
  ], true);

  printResult(parsed.flags, {
    revertBranch,
    revertedSha: mergedSha,
    prUrl: prUrl ?? null,
    message: [
      `Revert PR opened for ${revertShortSha}`,
      `Branch: ${revertBranch}`,
      prUrl ? `PR: ${prUrl}` : 'PR: (gh pr create did not return a URL — check `gh pr list`)',
      'No sha was pushed to main. Review + merge the PR to land the revert.',
    ].join('\n'),
  });
}

function findLatestRecord(options: {
  records: DeployRecord[];
  environment: 'staging' | 'prod';
  surfaces: string[];
}): DeployRecord | null {
  const key = [...options.surfaces].sort().join(',');
  for (let i = options.records.length - 1; i >= 0; i -= 1) {
    const record = options.records[i];
    if (record.environment !== options.environment) continue;
    if (!record.sha) continue;
    const recordKey = [...(record.surfaces ?? [])].sort().join(',');
    if (recordKey !== key) continue;
    return record;
  }
  return null;
}

function resolveLastMergedShaFromGit(repoRoot: string, baseBranch: string): string | null {
  // Last commit on the base branch that looks like a PR merge commit.
  // GitHub's squash-merge produces `Merge pull request #N`-style subjects
  // on the merge commit; we fall back to `HEAD` if nothing matches so the
  // operator at least gets a deterministic sha to revert.
  const last = runGit(
    repoRoot,
    ['log', '-n', '1', '--format=%H', `origin/${baseBranch}`],
    true,
  ) ?? runGit(repoRoot, ['log', '-n', '1', '--format=%H', baseBranch], true);
  return last ? last.trim() : null;
}
