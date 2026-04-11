import { useCallback, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { hdxServer } from '@/api';

export interface InvestigationMemory {
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  rootCause?: string;
  findings: {
    service: string;
    symptom: string;
    rootCause: string;
    confidence: string;
    wasVerified: boolean;
  }[];
  artifactsCreated: { type: string; id: string; purpose: string }[];
  recurrenceCount: number;
}

export interface Investigation {
  _id: string;
  team: string;
  createdBy: string;
  title: string;
  status:
    | 'active'
    | 'resolved'
    | 'exported'
    | 'pending'
    | 'failed'
    | 'needs_review'
    | 'ignored';
  entryPoint: {
    type: 'trace' | 'alert' | 'standalone' | 'proactive';
    traceId?: string;
    alertId?: string;
  };
  messages: InvestigationMessage[];
  summary?: string;
  sharedWith?: string[];
  exports?: { format: string; content: string; createdAt: string }[];
  createdAt: string;
  updatedAt: string;
  source?: 'alert' | 'anomaly';
  fingerprint?: string;
  sourceRef?: string;
  attemptCount?: number;
  artifacts?: {
    type: 'savedSearch' | 'dashboard' | 'alert';
    id: string;
    purpose: string;
  }[];
  recurrenceCount?: number;
  memory?: InvestigationMemory;
}

export interface InvestigationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: { name: string; args: unknown; result: unknown }[];
  timestamp: string;
}

export function useInvestigations(page = 1, limit = 20, source?: string) {
  return useQuery({
    queryKey: ['investigations', page, limit, source],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (source) params.set('source', source);
      return hdxServer(`investigations?${params.toString()}`).json<{
        data: Investigation[];
        total: number;
      }>();
    },
  });
}

export function useInvestigation(id: string | undefined) {
  return useQuery({
    queryKey: ['investigation', id],
    queryFn: () => hdxServer(`investigations/${id}`).json<Investigation>(),
    enabled: !!id,
  });
}

export function useCreateInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      entryPoint: Investigation['entryPoint'];
      sourceId?: string;
    }) =>
      hdxServer('investigations', {
        method: 'POST',
        json: data,
      }).json<Investigation>(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investigations'] });
    },
  });
}

export function useUpdateInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...updates
    }: {
      id: string;
      title?: string;
      status?: string;
      sharedWith?: string[];
    }) =>
      hdxServer(`investigations/${id}`, {
        method: 'PATCH',
        json: updates,
      }).json<Investigation>(),
    onSuccess: (data: Investigation) => {
      queryClient.invalidateQueries({ queryKey: ['investigation', data._id] });
      queryClient.invalidateQueries({ queryKey: ['investigations'] });
    },
  });
}

export function useDeleteInvestigation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      hdxServer(`investigations/${id}`, { method: 'DELETE' }).json(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investigations'] });
    },
  });
}

export function useExportInvestigation() {
  return useMutation({
    mutationFn: ({
      id,
      format,
      sourceId,
    }: {
      id: string;
      format: 'markdown' | 'json';
      sourceId: string;
    }) =>
      hdxServer(`investigations/${id}/export`, {
        method: 'POST',
        json: { format, sourceId },
      }).json<Investigation>(),
  });
}

// SSE streaming hook for sending messages
export function useInvestigationChat(investigationId: string | undefined) {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamedText, setStreamedText] = useState('');
  const [toolEvents, setToolEvents] = useState<
    { name: string; args: unknown; result: unknown }[]
  >([]);
  const abortRef = useRef<AbortController | null>(null);
  const queryClient = useQueryClient();

  const sendMessage = useCallback(
    async (content: string, sourceId: string) => {
      if (!investigationId || isStreaming) return;

      setIsStreaming(true);
      setStreamedText('');
      setToolEvents([]);

      abortRef.current = new AbortController();

      try {
        const res = await fetch(
          `/api/investigations/${investigationId}/messages`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, sourceId }),
            signal: abortRef.current.signal,
          },
        );

        if (!res.ok) {
          throw new Error(`API error: ${res.status}`);
        }

        const reader = res.body?.getReader();
        const decoder = new TextDecoder();

        if (!reader) throw new Error('No response body');

        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = JSON.parse(line.slice(6));

            switch (data.type) {
              case 'text':
                setStreamedText(prev => prev + data.content);
                break;
              case 'tool':
                setToolEvents(prev => [
                  ...prev,
                  { name: data.name, args: data.args, result: data.result },
                ]);
                break;
              case 'done':
                break;
              case 'error':
                throw new Error(data.message);
            }
          }
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
        queryClient.invalidateQueries({
          queryKey: ['investigation', investigationId],
        });
      }
    },
    [investigationId, isStreaming, queryClient],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {
    sendMessage,
    cancel,
    isStreaming,
    streamedText,
    toolEvents,
  };
}
