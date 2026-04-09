import { initSDK } from '@hyperdx/node-opentelemetry/build/src/otel';
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
