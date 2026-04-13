import { useEffect, useMemo, useState } from 'react';
import Head from 'next/head';
import {
  ActionIcon,
  Anchor,
  Box,
  Code,
  Container,
  CopyButton,
  Group,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import {
  IconClipboard,
  IconClipboardCheck,
  IconExternalLink,
} from '@tabler/icons-react';

import { PageHeader } from './components/PageHeader';
import { useBrandDisplayName } from './theme/ThemeProvider';
import api from './api';
import { withAppNav } from './layout';

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

function CopyableField({ label, value }: { label: string; value: string }) {
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
                  <IconClipboardCheck
                    size={14}
                    color="var(--mantine-color-green-6)"
                  />
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
        'https://clickhouse.com/docs/use-cases/observability/clickstack/sdks/browser',
      docsLabel: 'ClickStack Browser SDK Docs',
      steps: [
        {
          title: 'Install the Browser SDK',
          description: 'Install the @hyperdx/browser package via npm:',
          code: 'npm install @hyperdx/browser',
        },
        {
          title: 'Initialize ClickStack',
          description:
            'Add the following to your application entry point (e.g. main.ts or index.ts):',
          code: `import HyperDX from '@hyperdx/browser';

HyperDX.init({
  url: '${otelEndpoint}',
  apiKey: '${apiKey}',
  service: 'my-frontend-app',
  tracePropagationTargets: [/api.myapp.domain/i], // Link frontend to backend traces
  consoleCapture: true, // Capture console logs
  advancedNetworkCapture: true, // Capture full HTTP request/response headers and bodies
});`,
        },
        {
          title: 'Attach User Information (Optional)',
          description:
            'Associate sessions and events with user identity for filtering in the UI:',
          code: `HyperDX.setGlobalAttributes({
  userId: user.id,
  userEmail: user.email,
  userName: user.name,
  teamName: user.team.name,
});`,
        },
        {
          title: 'Send Custom Actions (Optional)',
          description:
            'Track specific application events (e.g. sign up, form submission):',
          code: `HyperDX.addAction('Form-Completed', {
  formId: 'signup-form',
  formName: 'Signup Form',
  formType: 'signup',
});`,
        },
      ],
    },
    'react-native': {
      label: 'React Native',
      docsUrl:
        'https://clickhouse.com/docs/use-cases/observability/clickstack/sdks',
      docsLabel: 'ClickStack SDK Docs',
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
        'https://clickhouse.com/docs/use-cases/observability/clickstack/sdks/node-js',
      docsLabel: 'ClickStack Node.js SDK Docs',
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
        'https://clickhouse.com/docs/use-cases/observability/clickstack/sdks/dotnet',
      docsLabel: 'ClickStack .NET SDK Docs',
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

function OptionsTable() {
  const options = [
    {
      name: 'apiKey',
      description: 'Your Ingestion API Key.',
    },
    {
      name: 'service',
      description: 'The service name events will show up as in the UI.',
    },
    {
      name: 'tracePropagationTargets',
      description:
        'A list of regex patterns to match against HTTP requests to link frontend and backend traces. Adds a traceparent header to matching requests.',
    },
    {
      name: 'url',
      description:
        'The OpenTelemetry collector URL. Required for self-hosted instances.',
    },
    {
      name: 'consoleCapture',
      description: 'Capture all console logs (default: false).',
    },
    {
      name: 'advancedNetworkCapture',
      description:
        'Capture full request/response headers and bodies (default: false).',
    },
    {
      name: 'maskAllInputs',
      description: 'Mask all input fields in session replay (default: false).',
    },
    {
      name: 'maskAllText',
      description: 'Mask all text in session replay (default: false).',
    },
    {
      name: 'disableReplay',
      description: 'Disable session replay capture (default: false).',
    },
  ];

  return (
    <Box>
      <Text size="sm" fw={600} mb="xs">
        Configuration Options
      </Text>
      <Box
        style={{
          border: '1px solid var(--mantine-color-dark-4)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 13,
          }}
        >
          <thead>
            <tr
              style={{
                backgroundColor: 'var(--mantine-color-dark-7)',
              }}
            >
              <th
                style={{
                  padding: '8px 12px',
                  textAlign: 'left',
                  borderBottom: '1px solid var(--mantine-color-dark-4)',
                }}
              >
                Option
              </th>
              <th
                style={{
                  padding: '8px 12px',
                  textAlign: 'left',
                  borderBottom: '1px solid var(--mantine-color-dark-4)',
                }}
              >
                Description
              </th>
            </tr>
          </thead>
          <tbody>
            {options.map(opt => (
              <tr key={opt.name}>
                <td
                  style={{
                    padding: '6px 12px',
                    borderBottom: '1px solid var(--mantine-color-dark-5)',
                    fontFamily: 'monospace',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {opt.name}
                </td>
                <td
                  style={{
                    padding: '6px 12px',
                    borderBottom: '1px solid var(--mantine-color-dark-5)',
                    color: 'var(--mantine-color-dimmed)',
                  }}
                >
                  {opt.description}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Box>
    </Box>
  );
}

export default function IntegrationGuidePage() {
  const brandName = useBrandDisplayName();
  const [platform, setPlatform] = useState<Platform>('browser');
  const { data: team } = api.useTeam();

  const apiKey = team?.apiKey ?? '<YOUR_API_KEY>';
  const [configData, setConfigData] = useState<{
    collectorUrl?: string;
    internalCollectorUrl?: string;
  }>({});
  useEffect(() => {
    fetch('/api/config')
      .then(res => res.json())
      .then(data => setConfigData(data))
      .catch(() => {});
  }, []);
  const hostname =
    typeof window !== 'undefined' ? window.location.hostname : 'localhost';
  const isLocal = hostname === 'localhost' || hostname === '127.0.0.1';
  const otelEndpoint = isLocal
    ? 'http://localhost:4318'
    : `${typeof window !== 'undefined' ? window.location.protocol : 'https:'}//${hostname}`;
  const internalEndpoint =
    configData.internalCollectorUrl ?? 'http://otel-collector:4318';

  const platforms = useMemo(
    () => getPlatformConfig(apiKey, otelEndpoint),
    [apiKey, otelEndpoint],
  );

  const current = platforms[platform];

  return (
    <div className="IntegrationGuidePage">
      <Head>
        <title>Integration Guide - {brandName}</title>
      </Head>
      <PageHeader>
        <Title order={2}>Integration Guide</Title>
      </PageHeader>
      <Container size="md" py="xl">
        <Stack gap="lg">
          <Box>
            <Text size="sm" c="dimmed">
              Instrument your application to send logs, traces, metrics, and
              session replays to ClickStack.
            </Text>
          </Box>

          {/* API Key & Endpoint */}
          <Paper
            p="md"
            withBorder
            style={{
              backgroundColor: 'var(--mantine-color-dark-7)',
            }}
          >
            <Stack gap="sm">
              <CopyableField label="Ingestion API Key" value={apiKey} />
              <CopyableField
                label="OTEL Endpoint (External)"
                value={otelEndpoint}
              />
              <CopyableField
                label="OTEL Endpoint (Internal K8s)"
                value={internalEndpoint}
              />
              <Text size="xs" c="dimmed">
                Use the external endpoint for browser/mobile apps and services
                outside the cluster. Use the internal K8s endpoint for services
                running in the same cluster (msm namespace) — lower latency, no
                ingress hop.
              </Text>
            </Stack>
          </Paper>

          {/* Platform Selector */}
          <Box>
            <Text size="sm" fw={600} mb="xs">
              Select your platform
            </Text>
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
          </Box>

          {/* What gets captured (browser only) */}
          {platform === 'browser' && (
            <Paper
              p="md"
              withBorder
              style={{
                backgroundColor: 'var(--mantine-color-dark-7)',
              }}
            >
              <Text size="sm" fw={600} mb="xs">
                What gets captured
              </Text>
              <Group gap="lg">
                {[
                  'Console Logs',
                  'Session Replays',
                  'XHR/Fetch/Websocket Requests',
                  'Exceptions',
                ].map(item => (
                  <Text key={item} size="xs" c="dimmed">
                    {item}
                  </Text>
                ))}
              </Group>
            </Paper>
          )}

          {/* Steps */}
          {current.steps.map((step, index) => (
            <Box key={index}>
              <Group gap="xs" mb={4}>
                <Box
                  style={{
                    width: 24,
                    height: 24,
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
                <Text size="xs" c="dimmed" mb="xs" ml={32}>
                  {step.description}
                </Text>
              )}
              <Box ml={32}>
                <CodeBlock code={step.code} />
              </Box>
            </Box>
          ))}

          {/* Options table (browser only) */}
          {platform === 'browser' && (
            <Box ml={32}>
              <OptionsTable />
            </Box>
          )}

          {/* Script tag alternative (browser only) */}
          {platform === 'browser' && (
            <Box ml={32}>
              <Text size="sm" fw={600} mb="xs">
                Alternative: Script Tag
              </Text>
              <Text size="xs" c="dimmed" mb="xs">
                If your site doesn&apos;t use a bundler, include the SDK via a
                script tag:
              </Text>
              <CodeBlock
                code={`<script src="//www.unpkg.com/@hyperdx/browser/build/index.js"></script>
<script>
  window.HyperDX.init({
    url: '${otelEndpoint}',
    apiKey: '${apiKey}',
    service: 'my-frontend-app',
    tracePropagationTargets: [/api.myapp.domain/i],
  });
</script>`}
              />
            </Box>
          )}

          {/* Docs Link */}
          <Box ml={32} pb="xl">
            <Anchor
              href={current.docsUrl}
              target="_blank"
              rel="noreferrer"
              underline="hover"
            >
              <Group gap={4}>
                <Text size="sm" c="blue">
                  {current.docsLabel}
                </Text>
                <IconExternalLink
                  size={14}
                  color="var(--mantine-color-blue-5)"
                />
              </Group>
            </Anchor>
          </Box>
        </Stack>
      </Container>
    </div>
  );
}

IntegrationGuidePage.getLayout = withAppNav;
