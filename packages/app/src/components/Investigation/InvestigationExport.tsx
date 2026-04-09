import { useState } from 'react';
import {
  Box,
  Button,
  CopyButton,
  Group,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
} from '@mantine/core';

interface InvestigationExportProps {
  opened: boolean;
  onClose: () => void;
  exports: { format: string; content: string; createdAt: string }[];
  onExport: (format: 'markdown' | 'json') => void;
  isExporting: boolean;
}

export default function InvestigationExport({
  opened,
  onClose,
  exports: exportsList,
  onExport,
  isExporting,
}: InvestigationExportProps) {
  const [selectedFormat, setSelectedFormat] = useState<'markdown' | 'json'>(
    'markdown',
  );
  const latestExport = exportsList?.[exportsList.length - 1];

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Export Investigation"
      size="lg"
    >
      <Stack gap="md">
        {!latestExport ? (
          <>
            <Text size="sm">
              Generate an incident report from this investigation. The AI will
              synthesize all findings into a structured report.
            </Text>
            <SegmentedControl
              data={[
                { label: 'Markdown', value: 'markdown' },
                { label: 'JSON', value: 'json' },
              ]}
              value={selectedFormat}
              onChange={v => setSelectedFormat(v as 'markdown' | 'json')}
            />
            <Button
              variant="primary"
              onClick={() => onExport(selectedFormat)}
              loading={isExporting}
            >
              Generate Report
            </Button>
          </>
        ) : (
          <>
            <Group justify="space-between">
              <Text size="sm" fw={500}>
                Generated {new Date(latestExport.createdAt).toLocaleString()}
              </Text>
              <CopyButton value={latestExport.content}>
                {({ copied, copy }) => (
                  <Button variant="secondary" size="xs" onClick={copy}>
                    {copied ? 'Copied!' : 'Copy'}
                  </Button>
                )}
              </CopyButton>
            </Group>
            <Textarea
              value={latestExport.content}
              readOnly
              autosize
              minRows={10}
              maxRows={20}
            />
            <Button
              variant="secondary"
              onClick={() => onExport(selectedFormat)}
            >
              Regenerate
            </Button>
          </>
        )}
      </Stack>
    </Modal>
  );
}
