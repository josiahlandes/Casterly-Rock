import type { AppConfig } from '../config/schema.js';
import type { ProviderRegistry } from '../providers/index.js';
import { safeLogger } from '../logging/safe-logger.js';
import { detectSensitiveContent } from '../security/detector.js';
import { classifyRoute } from './classifier.js';
import type { RouteDecision } from './classifier.js';

export interface RouterDependencies {
  config: AppConfig;
  providers: ProviderRegistry;
}

export async function routeRequest(
  input: string,
  deps: RouterDependencies
): Promise<RouteDecision> {
  const sensitivity = detectSensitiveContent(input, {
    alwaysLocalCategories: deps.config.sensitivity.alwaysLocal
  });

  if (sensitivity.isSensitive) {
    const reason =
      sensitivity.reasons[0] ?? 'Detected sensitive content; forcing local route.';

    safeLogger.info('Routing locally due to sensitive content.', {
      categories: sensitivity.categories,
      reason
    });

    return {
      route: 'local',
      reason,
      confidence: 1,
      sensitiveCategories: sensitivity.categories
    };
  }

  const decision = await classifyRoute(
    input,
    { localProvider: deps.providers.local },
    {
      defaultRoute: deps.config.router.defaultRoute,
      confidenceThreshold: deps.config.router.confidenceThreshold,
      alwaysLocalCategories: deps.config.sensitivity.alwaysLocal
    },
    sensitivity.categories
  );

  if (decision.route === 'cloud' && decision.confidence < deps.config.router.confidenceThreshold) {
    const reason = `Classifier confidence ${decision.confidence.toFixed(2)} below threshold ${deps.config.router.confidenceThreshold.toFixed(2)}; routing locally.`;

    safeLogger.warn(reason);

    return {
      ...decision,
      route: 'local',
      reason,
      confidence: deps.config.router.confidenceThreshold
    };
  }

  if (decision.route === 'cloud' && !deps.providers.cloud) {
    const reason = 'Cloud route requested but no cloud provider is configured; routing locally.';
    safeLogger.warn(reason);

    return {
      ...decision,
      route: 'local',
      reason,
      confidence: 1
    };
  }

  return decision;
}
