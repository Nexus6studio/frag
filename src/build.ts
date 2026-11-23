/**
 * Seven-character build id for the content-warning card.
 *
 * `GITHUB_SHA` wins when it is set. On a GitHub Actions pull request that
 * value is the merge commit of the head into the base branch, not the branch
 * head, so a PR preview can show a different id than `git rev-parse` on the
 * branch. Otherwise the id is the leading seven hex characters of the local
 * git revision. Anything else is `dev`.
 */
export function shortBuildId(githubSha: string | null | undefined, gitShort: string | null | undefined): string {
  return leadingSeven(githubSha) ?? leadingSeven(gitShort) ?? "dev";
}

function leadingSeven(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) return null;
  return trimmed.slice(0, 7);
}
