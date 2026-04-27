export const PIPELANE_GITHUB_URL = 'https://github.com/jokim1/pipelane.git';
export const PIPELANE_REPO_SLUG = 'jokim1/pipelane';
export const DEFAULT_PIPELANE_INSTALL_SPEC = 'pipelane@github:jokim1/pipelane#main';

export function resolvePipelaneInstallSpec(): string {
  const override = process.env.PIPELANE_INSTALL_SPEC?.trim();
  return override || DEFAULT_PIPELANE_INSTALL_SPEC;
}

export function resolvePipelaneInstallSpecForSha(sha: string): string {
  const override = process.env.PIPELANE_INSTALL_SPEC?.trim();
  return override || `pipelane@github:${PIPELANE_REPO_SLUG}#${sha}`;
}
