import type { AICapability, LogicalModel, ProviderAdapter, ProviderName, RiskLevel } from './contracts';
import { fallbackProviders, logicalModelFor, primaryProvider, resolveModel } from './registry';

export interface RouteCandidate {
  provider: ProviderName;
  adapter: ProviderAdapter;
  model?: string;
}

export interface RoutePlan {
  primaryProvider: ProviderName;
  logicalModel: LogicalModel;
  candidates: RouteCandidate[];
}

export function buildRoutePlan(args: {
  capability: AICapability;
  logicalModel?: LogicalModel;
  riskLevel?: RiskLevel;
  fallback?: 'allowed' | 'disabled';
  adapters: Map<ProviderName, ProviderAdapter>;
}): RoutePlan {
  const primary = primaryProvider();
  const logicalModel = logicalModelFor(args.capability, args.logicalModel);
  const providers = [primary, ...(args.fallback === 'disabled' ? [] : fallbackProviders())]
    .filter((value, index, all) => all.indexOf(value) === index);
  return {
    primaryProvider: primary,
    logicalModel,
    candidates: providers.flatMap(provider => {
      const adapter = args.adapters.get(provider);
      return adapter ? [{ provider, adapter, model: resolveModel(logicalModel, provider, primary) }] : [];
    }),
  };
}
