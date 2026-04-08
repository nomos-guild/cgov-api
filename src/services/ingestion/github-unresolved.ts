interface GitHubGraphQLErrorLike {
  name: string;
  errors: Array<{ message?: unknown }>;
  cause?: unknown;
}

export const unresolvedRepoDisableThreshold = 2;

const unresolvedRepoRegex =
  /Could not resolve to a Repository with the name '([^']+)'/g;

function isGitHubGraphQLErrorLike(value: unknown): value is GitHubGraphQLErrorLike {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeError = value as { name?: unknown; errors?: unknown };
  return (
    maybeError.name === "GitHubGraphQLError" &&
    Array.isArray(maybeError.errors)
  );
}

export function unwrapGitHubGraphQLError(error: unknown): GitHubGraphQLErrorLike | null {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current && typeof current === "object" && !seen.has(current)) {
    if (isGitHubGraphQLErrorLike(current)) {
      return current;
    }

    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }

  return null;
}

export function getUnresolvedRepoNamesFromGraphQLError(error: unknown): Set<string> {
  const gqlError = unwrapGitHubGraphQLError(error);
  if (!gqlError) {
    return new Set();
  }

  const unresolved = new Set<string>();
  for (const gqlErrorItem of gqlError.errors) {
    const message = String(gqlErrorItem?.message ?? "");
    for (const match of message.matchAll(unresolvedRepoRegex)) {
      if (match[1]) {
        unresolved.add(match[1]);
      }
    }
  }

  return unresolved;
}

export function isDeterministicGitHubUnresolvedError(error: unknown): boolean {
  return getUnresolvedRepoNamesFromGraphQLError(error).size > 0;
}

export function isRepoUnresolvedInGraphQLError(
  error: unknown,
  fullRepoName: string
): boolean {
  return getUnresolvedRepoNamesFromGraphQLError(error).has(fullRepoName);
}
