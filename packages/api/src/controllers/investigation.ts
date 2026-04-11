import Alert from '@/models/alert';
import type {
  EntryPointType,
  InvestigationStatus,
} from '@/models/investigation';
import Investigation from '@/models/investigation';
import InvestigationMemory from '@/models/investigationMemory';

export async function createInvestigation({
  teamId,
  userId,
  title,
  entryPoint,
}: {
  teamId: string;
  userId: string;
  title: string;
  entryPoint: { type: EntryPointType; traceId?: string; alertId?: string };
}) {
  return Investigation.create({
    team: teamId,
    createdBy: userId,
    title,
    status: 'active',
    entryPoint,
    messages: [],
  });
}

export async function createAlertInvestigation({
  teamId,
  userId,
  alertId,
}: {
  teamId: string;
  userId: string;
  alertId: string;
}) {
  const alert = await Alert.findOne({ _id: alertId, team: teamId });
  if (!alert) throw new Error('Alert not found');

  const investigation = await Investigation.create({
    team: teamId,
    createdBy: userId,
    title: `Alert: ${alert.name || 'Unnamed alert'}`,
    status: 'active',
    entryPoint: { type: 'alert', alertId },
    messages: [
      {
        role: 'user',
        content: `Investigate this alert: "${alert.name || 'Alert'}". It triggered with threshold ${JSON.stringify(alert.threshold)} (${alert.thresholdType}). Interval: ${alert.interval}. Please fetch relevant traces, logs, and metrics to identify the root cause.`,
        timestamp: new Date(),
      },
    ],
  });

  return investigation;
}

export async function listInvestigations({
  teamId,
  page = 1,
  limit = 20,
  source,
}: {
  teamId: string;
  page?: number;
  limit?: number;
  source?: string;
}) {
  const skip = (page - 1) * limit;
  const filter: Record<string, unknown> = { team: teamId };
  if (source === 'proactive') {
    filter['entryPoint.type'] = 'proactive';
  }
  const [data, total] = await Promise.all([
    Investigation.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-messages')
      .lean(),
    Investigation.countDocuments(filter),
  ]);

  // Attach recurrenceCount for proactive investigations (single batched query)
  const proactiveIds = data
    .filter(inv => inv.entryPoint?.type === 'proactive')
    .map(inv => inv._id);
  const memories =
    proactiveIds.length > 0
      ? await InvestigationMemory.find({
          investigationId: { $in: proactiveIds },
        })
          .select('investigationId recurrenceCount')
          .lean()
      : [];
  const memoryMap = new Map(
    memories.map(m => [m.investigationId.toString(), m.recurrenceCount]),
  );
  const enrichedData = data.map(inv => {
    if (inv.entryPoint?.type === 'proactive') {
      return { ...inv, recurrenceCount: memoryMap.get(inv._id.toString()) ?? 0 };
    }
    return inv;
  });

  return { data: enrichedData, total, page, limit };
}

export async function getInvestigation({
  teamId,
  investigationId,
  withMemory = false,
}: {
  teamId: string;
  investigationId: string;
  withMemory?: boolean;
}) {
  const investigation = await Investigation.findOne({
    _id: investigationId,
    team: teamId,
  }).lean();

  if (!investigation) return null;

  if (withMemory) {
    const memory = await InvestigationMemory.findOne({
      investigationId: investigation._id,
    }).lean();
    return { ...investigation, memory: memory ?? null };
  }

  return investigation;
}

export async function updateInvestigation({
  teamId,
  investigationId,
  updates,
}: {
  teamId: string;
  investigationId: string;
  updates: Partial<{
    title: string;
    status: InvestigationStatus;
    sharedWith: string[];
    summary: string;
  }>;
}) {
  return Investigation.findOneAndUpdate(
    { _id: investigationId, team: teamId },
    { $set: updates },
    { new: true },
  ).lean();
}

export async function deleteInvestigation({
  teamId,
  investigationId,
}: {
  teamId: string;
  investigationId: string;
}) {
  return Investigation.findOneAndDelete({
    _id: investigationId,
    team: teamId,
  });
}

export async function appendMessage({
  teamId,
  investigationId,
  message,
}: {
  teamId: string;
  investigationId: string;
  message: {
    role: 'user' | 'assistant' | 'tool';
    content: string;
    toolCalls?: { name: string; args: unknown; result: unknown }[];
  };
}) {
  return Investigation.findOneAndUpdate(
    { _id: investigationId, team: teamId },
    {
      $push: {
        messages: { ...message, timestamp: new Date() },
      },
    },
    { new: true },
  ).lean();
}

export async function addExport({
  teamId,
  investigationId,
  exportData,
}: {
  teamId: string;
  investigationId: string;
  exportData: { format: 'markdown' | 'json'; content: string };
}) {
  return Investigation.findOneAndUpdate(
    { _id: investigationId, team: teamId },
    {
      $push: {
        exports: { ...exportData, createdAt: new Date() },
      },
      $set: { status: 'exported' },
    },
    { new: true },
  ).lean();
}
