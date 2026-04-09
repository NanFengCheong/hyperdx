import Investigation from '@/models/investigation';
import type {
  EntryPointType,
  InvestigationStatus,
} from '@/models/investigation';

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

export async function listInvestigations({
  teamId,
  page = 1,
  limit = 20,
}: {
  teamId: string;
  page?: number;
  limit?: number;
}) {
  const skip = (page - 1) * limit;
  const [data, total] = await Promise.all([
    Investigation.find({ team: teamId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('-messages')
      .lean(),
    Investigation.countDocuments({ team: teamId }),
  ]);
  return { data, total, page, limit };
}

export async function getInvestigation({
  teamId,
  investigationId,
}: {
  teamId: string;
  investigationId: string;
}) {
  return Investigation.findOne({
    _id: investigationId,
    team: teamId,
  }).lean();
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
