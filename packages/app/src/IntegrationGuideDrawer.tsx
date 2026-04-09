import { useMemo, useState } from 'react';
import {
  Box,
  Code,
  CopyButton,
  Drawer,
  Group,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  ActionIcon,
  Tooltip,
} from '@mantine/core';
import {
  IconClipboard,
  IconClipboardCheck,
  IconExternalLink,
} from '@tabler/icons-react';

import api from './api';

type Platform = 'browser' | 'react-native' | 'nodejs' | 'dotnet';

interface IntegrationStep {
  title: string;
  description?: string;
  code: string;
  language?: string;
}

interface PlatformConfig {
  label: string;
  steps: IntegrationStep[];
  docsUrl: string;
  docsLabel: string;
}

function CodeBlock({ code }: { code: string }) {
  return (
    <Box pos="relative">
      <CopyButton value={code}>
        {({ copied, copy }) => (
          <Tooltip label={copied ? 'Copied!' : 'Copy'} position="left">
            <ActionIcon
              variant="subtle"
              size="sm"
              onClick={copy}
              pos="absolute"
              top={8}
              right={8}
              style={{ zIndex: 1 }}
            >
              {copied ? (
                <IconClipboardCheck size={14} />
              ) : (
                <IconClipboard size={14} />
              )}
            </ActionIcon>
          </Tooltip>
        )}
      </CopyButton>
      <Code
        block
        style={{
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {code}
      </Code>
    </Box>
  );
}

function CopyableField({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <Box>
      <Text size="xs" c="dimmed" mb={2}>
        {label}
      </Text>
      <CopyButton value={value}>
        {({ copied, copy }) => (
          <Group
            gap="xs"
            onClick={copy}
            style={{
              cursor: 'pointer',
              border: '1px solid var(--mantine-color-dark-4)',
              borderRadius: 6,
              padding: '6px 10px',
            }}
          >
            <Text
              size="xs"
              ff="monospace"
              style={{ flex: 1, wordBreak: 'break-all' }}
            >
              {value}
            </Text>
            <Tooltip label={copied ? 'Copied!' : 'Copy'}>
              <ActionIcon variant="subtle" size="sm">
                {copied ? (
                  <IconClipboardCheck size={14} color="var(--mantine-color-green-6)" />
                ) : (
                  <IconClipboard size={14} />
                )}
              </ActionIcon>
            </Tooltip>
          </Group>
        )}
      </CopyButton>
    </Box>
  );
}

function getPlatformConfig(
  apiKey: string,
  otelEndpoint: string,
): Record<Platform, PlatformConfig> {
  return {
    browser: {
      label: 'Browser',
      docsUrl:
        'https://opentelemetry.io/docs/languages/js/getting-started/browser/',
      docsLabel: 'OpenTelemetry Browser SDK Docs',
      steps: [
        {
          title: 'Install Dependencies',
          code: `npm install @opentelemetry/api \\
  @opentelemetry/sdk-trace-web \\
  @opentelemetry/instrumentation-document-load \\
  @opentelemetry/instrumentation-fetch \\
  @opentelemetry/instrumentation-xml-http-request \\
  @opentelemetry/exporter-trace-otlp-http \\
  @opentelemetry/resources \\
  @opentelemetry/semantic-conventions`,
        },
        {
          title: 'Configure Tracing',
          description: 'Create a tracing.ts file in your project:',
          code: `import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { XMLHttpRequestInstrumentation } from '@opentelemetry/instrumentation-xml-http-request';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

const resource = new Resource({
  [ATTR_SERVICE_NAME]: 'my-web-app',
});

const exporter = new OTLPTraceExporter({
  url: '${otelEndpoint}/v1/traces',
  headers: {
    Authorization: '${apiKey}',
  },
});

const provider = new WebTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
provider.register();

registerInstrumentations({
  instrumentations: [
    new DocumentLoadInstrumentation(),
    new FetchInstrumentation(),
    new XMLHttpRequestInstrumentation(),
  ],
});`,
        },
        {
          title: 'Initialize',
          description: 'Import the tracing config at the entry point of your app:',
          code: `// main.ts or index.ts
import './tracing';

// Your app code here...`,
        },
      ],
    },
    'react-native': {
      label: 'React Native',
      docsUrl:
        'https://opentelemetry.io/docs/languages/js/getting-started/',
      docsLabel: 'OpenTelemetry JS SDK Docs',
      steps: [
        {
          title: 'Install Dependencies',
          code: `npm install @opentelemetry/api \\
  @opentelemetry/sdk-trace-base \\
  @opentelemetry/exporter-trace-otlp-http \\
  @opentelemetry/resources \\
  @opentelemetry/semantic-conventions`,
        },
        {
          title: 'Configure Tracing',
          description: 'Create an instrumentation.ts file:',
          code: `import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const resource = new Resource({
  [ATTR_SERVICE_NAME]: 'my-react-native-app',
});

const exporter = new OTLPTraceExporter({
  url: '${otelEndpoint}/v1/traces',
  headers: {
    Authorization: '${apiKey}',
  },
});

const provider = new BasicTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(exporter)],
});
provider.register();

export default provider;`,
        },
        {
          title: 'Initialize',
          description: 'Import at the top of your App.tsx:',
          code: `// App.tsx
import './instrumentation';

// Your app code here...`,
        },
        {
          title: 'Send a Test Span',
          description: 'Verify the setup by creating a manual span:',
          code: `import { trace } from '@opentelemetry/api';

const tracer = trace.getTracer('test');
const span = tracer.startSpan('test-span');
span.setAttribute('test.key', 'hello');
span.end();`,
        },
      ],
    },
    nodejs: {
      label: 'Node.js',
      docsUrl:
        'https://opentelemetry.io/docs/languages/js/getting-started/nodejs/',
      docsLabel: 'OpenTelemetry Node.js SDK Docs',
      steps: [
        {
          title: 'Install Dependencies',
          code: `npm install @opentelemetry/sdk-node \\
  @opentelemetry/api \\
  @opentelemetry/auto-instrumentations-node \\
  @opentelemetry/exporter-trace-otlp-http \\
  @opentelemetry/exporter-logs-otlp-http \\
  @opentelemetry/sdk-logs`,
        },
        {
          title: 'Configure SDK',
          description: 'Create an instrumentation.ts file:',
          code: `import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
import { SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { Resource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

const sdk = new NodeSDK({
  resource: new Resource({
    [ATTR_SERVICE_NAME]: 'my-node-service',
  }),
  traceExporter: new OTLPTraceExporter({
    url: '${otelEndpoint}/v1/traces',
    headers: { Authorization: '${apiKey}' },
  }),
  logRecordProcessors: [
    new SimpleLogRecordProcessor(
      new OTLPLogExporter({
        url: '${otelEndpoint}/v1/logs',
        headers: { Authorization: '${apiKey}' },
      }),
    ),
  ],
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();`,
        },
        {
          title: 'Run Your App',
          description: 'Load the instrumentation before your app starts:',
          code: `node --require ./instrumentation.ts your-app.ts

# Or with ts-node:
node --require ts-node/register --require ./instrumentation.ts your-app.ts

# Or set env vars instead:
OTEL_EXPORTER_OTLP_ENDPOINT=${otelEndpoint} \\
OTEL_EXPORTER_OTLP_HEADERS="Authorization=${apiKey}" \\
OTEL_SERVICE_NAME=my-node-service \\
node --require @opentelemetry/auto-instrumentations-node/register your-app.js`,
        },
      ],
    },
    dotnet: {
      label: 'ASP.NET Core',
      docsUrl:
        'https://opentelemetry.io/docs/languages/dotnet/getting-started/',
      docsLabel: 'OpenTelemetry .NET SDK Docs',
      steps: [
        {
          title: 'Install NuGet Packages',
          code: `dotnet add package OpenTelemetry.Extensions.Hosting
dotnet add package OpenTelemetry.Instrumentation.AspNetCore
dotnet add package OpenTelemetry.Instrumentation.Http
dotnet add package OpenTelemetry.Exporter.OpenTelemetryProtocol`,
        },
        {
          title: 'Configure in Program.cs',
          description: 'Add OpenTelemetry to your service configuration:',
          code: `using OpenTelemetry.Logs;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenTelemetry()
    .ConfigureResource(resource => resource
        .AddService("my-dotnet-service"))
    .WithTracing(tracing => tracing
        .AddAspNetCoreInstrumentation()
        .AddHttpClientInstrumentation()
        .AddOtlpExporter(opts =>
        {
            opts.Endpoint = new Uri("${otelEndpoint}");
            opts.Headers = "Authorization=${apiKey}";
        }))
    .WithLogging(logging => logging
        .AddOtlpExporter(opts =>
        {
            opts.Endpoint = new Uri("${otelEndpoint}");
            opts.Headers = "Authorization=${apiKey}";
        }));

var app = builder.Build();
app.MapControllers();
app.Run();`,
        },
        {
          title: 'Run & Verify',
          description: 'Start your application and check for telemetry:',
          code: `dotnet run

# Or set env vars:
# OTEL_EXPORTER_OTLP_ENDPOINT=${otelEndpoint}
# OTEL_EXPORTER_OTLP_HEADERS=Authorization=${apiKey}
# OTEL_SERVICE_NAME=my-dotnet-service`,
        },
      ],
    },
  };
}

export default function IntegrationGuideDrawer({
  opened,
  onClose,
}: {
  opened: boolean;
  onClose: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>('nodejs');
  const { data: team } = api.useTeam();

  const apiKey = team?.apiKey ?? '<YOUR_API_KEY>';
  const otelEndpoint = typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname}:4318`
    : 'http://localhost:4318';

  const platforms = useMemo(
    () => getPlatformConfig(apiKey, otelEndpoint),
    [apiKey, otelEndpoint],
  );

  const current = platforms[platform];

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size={600}
      title={
        <Text size="lg" fw={600}>
          Integration Guide
        </Text>
      }
      styles={{
        body: { padding: 0, height: 'calc(100vh - 60px)' },
      }}
    >
      <ScrollArea h="100%" px="md" pb="md">
        <Stack gap="md" py="md">
          {/* API Key & Endpoint */}
          <Box
            p="sm"
            style={{
              border: '1px solid var(--mantine-color-dark-4)',
              borderRadius: 8,
              backgroundColor: 'var(--mantine-color-dark-7)',
            }}
          >
            <Stack gap="xs">
              <CopyableField label="Ingestion API Key" value={apiKey} />
              <CopyableField label="OTEL Endpoint" value={otelEndpoint} />
            </Stack>
          </Box>

          {/* Platform Selector */}
          <SegmentedControl
            value={platform}
            onChange={v => setPlatform(v as Platform)}
            fullWidth
            data={[
              { label: 'Browser', value: 'browser' },
              { label: 'React Native', value: 'react-native' },
              { label: 'Node.js', value: 'nodejs' },
              { label: 'ASP.NET Core', value: 'dotnet' },
            ]}
          />

          {/* Steps */}
          {current.steps.map((step, index) => (
            <Box key={index}>
              <Group gap="xs" mb={4}>
                <Box
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: '1px solid var(--mantine-color-dark-4)',
                    flexShrink: 0,
                  }}
                >
                  <Text size="xs" fw="bold">
                    {index + 1}
                  </Text>
                </Box>
                <Text size="sm" fw={600}>
                  {step.title}
                </Text>
              </Group>
              {step.description && (
                <Text size="xs" c="dimmed" mb="xs" ml={30}>
                  {step.description}
                </Text>
              )}
              <Box ml={30}>
                <CodeBlock code={step.code} />
              </Box>
            </Box>
          ))}

          {/* Docs Link */}
          <Box ml={30}>
            <a
              href={current.docsUrl}
              target="_blank"
              rel="noreferrer"
              style={{ textDecoration: 'none' }}
            >
              <Group gap={4}>
                <Text size="sm" c="blue">
                  {current.docsLabel}
                </Text>
                <IconExternalLink size={14} color="var(--mantine-color-blue-5)" />
              </Group>
            </a>
          </Box>
        </Stack>
      </ScrollArea>
    </Drawer>
  );
}
