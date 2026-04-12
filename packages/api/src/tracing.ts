import { initSDK } from '@hyperdx/node-opentelemetry/build/src/otel';
// eslint-disable-next-line n/no-extraneous-import -- Express instrumentation is a dev peer dependency used for tracing
import { ExpressLayerType } from '@opentelemetry/instrumentation-express';

initSDK({
  instrumentations: {
    '@opentelemetry/instrumentation-express': {
      // Suppress noisy middleware spans (query, expressInit, compression, etc.)
      // that clutter traces without adding diagnostic value.
      // Only router and request_handler spans are kept.
      ignoreLayersType: [ExpressLayerType.MIDDLEWARE],
    },
  },
});
