import { createHash } from 'crypto';

export interface Rule {
  type: 'explicit' | 'tenant' | 'cohort' | 'percentage';
  // explicit: match specific userId or tenantId values
  userIds?: string[];
  tenantIds?: string[];
  // tenant: match by plan tier
  planTier?: string;
  // cohort: match by a named user attribute
  attribute?: string;
  attributeValue?: string | boolean | number;
  // percentage: deterministic hash-based rollout
  percentage?: number;
  // value to return when this rule matches
  value: boolean | string | number;
}

export interface Flag {
  key: string;
  type: 'release' | 'experiment' | 'ops' | 'permission';
  valueType: 'boolean' | 'string' | 'number';
  defaultValue: boolean | string | number;
  safeDefault: boolean | string | number;
  rules: Rule[];
  owner: string;
  expiresAt: string | null;
}

export interface EvalContext {
  userId?: string;
  tenantId?: string;
  planTier?: string;
  attributes?: Record<string, string | boolean | number>;
}

export interface EvalResult {
  variant: boolean | string | number;
  ruleMatched: string;
}

/**
 * Evaluate a flag against a user context.
 *
 * Rules are evaluated in strict priority order:
 *   1. explicit override (userId or tenantId in allow-list)
 *   2. tenant rule (tenantId or planTier match)
 *   3. cohort/segment rule (user attribute match)
 *   4. percentage rollout (deterministic hash on flagKey + userId)
 *   5. global default (flag.defaultValue)
 *
 * Returns safeDefault if flag is null/undefined (flag not found in cache).
 */
export function evaluateFlag(flag: Flag | undefined, context: EvalContext): EvalResult {
  if (!flag) {
    return { variant: false, ruleMatched: 'safe-default' };
  }

  for (let i = 0; i < flag.rules.length; i++) {
    const rule = flag.rules[i];
    const ruleName = `rule-${i}-${rule.type}`;

    if (rule.type === 'explicit') {
      if (context.userId && rule.userIds?.includes(context.userId)) {
        return { variant: rule.value, ruleMatched: `${ruleName}:userId` };
      }
      if (context.tenantId && rule.tenantIds?.includes(context.tenantId)) {
        return { variant: rule.value, ruleMatched: `${ruleName}:tenantId` };
      }
    }

    if (rule.type === 'tenant') {
      if (context.tenantId && rule.tenantIds?.includes(context.tenantId)) {
        return { variant: rule.value, ruleMatched: `${ruleName}:tenantId` };
      }
      if (context.planTier && rule.planTier === context.planTier) {
        return { variant: rule.value, ruleMatched: `${ruleName}:planTier` };
      }
    }

    if (rule.type === 'cohort') {
      const attrValue = context.attributes?.[rule.attribute ?? ''];
      if (rule.attribute && attrValue === rule.attributeValue) {
        return { variant: rule.value, ruleMatched: `${ruleName}:cohort` };
      }
    }

    if (rule.type === 'percentage' && rule.percentage !== undefined) {
      const userId = context.userId ?? 'anonymous';
      // Include flag key as salt so percentile is independent per flag
      const hash = createHash('sha256').update(`${flag.key}:${userId}`).digest('hex');
      const percentile = parseInt(hash.slice(0, 8), 16) % 100;
      if (percentile < rule.percentage) {
        return { variant: rule.value, ruleMatched: `${ruleName}:percentage-${rule.percentage}` };
      }
    }
  }

  return { variant: flag.defaultValue, ruleMatched: 'global-default' };
}
