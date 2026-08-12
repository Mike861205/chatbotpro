const DEFAULT_BRANCH_LIMIT = 2;
const MAX_BRANCH_LIMIT = 1000;

function normalizeBranchLimit(value, fallback = DEFAULT_BRANCH_LIMIT) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_BRANCH_LIMIT);
}

function branchCapacity(activeBranches, branchLimit) {
  const active = Math.max(0, Number(activeBranches || 0));
  const limit = normalizeBranchLimit(branchLimit);
  return {
    active,
    limit,
    available: Math.max(0, limit - active),
    reached: active >= limit,
  };
}

module.exports = { DEFAULT_BRANCH_LIMIT, MAX_BRANCH_LIMIT, normalizeBranchLimit, branchCapacity };
