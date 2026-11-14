import {
  anthropicResetGrantBlocker,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';

/** Whether `grantId` can be spent right now: no blocker, no cooldown, inside its dates. */
export function isResetGrantSpendable(
  status: AnthropicResetGrantStatus,
  grantId: string,
  now: number
) {
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return false;
  const grant = status.grants.find((candidate) => candidate.id === grantId);
  return Boolean(
    grant &&
    !anthropicResetGrantBlocker(status, grantId) &&
    (!grant.startsAt || Date.parse(grant.startsAt) <= now) &&
    (!grant.endsAt || Date.parse(grant.endsAt) > now)
  );
}

/** Prefer the upstream recommendation; otherwise use stable ID ordering. */
export function selectResetGrant(status: AnthropicResetGrantStatus, now: number) {
  const usable = status.grants.filter((grant) => isResetGrantSpendable(status, grant.id, now));
  return (
    usable.find((grant) => grant.id === status.nextGrantId) ??
    usable.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]
  );
}
