import mongoose, { Schema } from 'mongoose';

import type { ObjectId } from '.';

export type InvestigationStatus =
  | 'active'
  | 'resolved'
  | 'exported'
  | 'pending'
  | 'failed'
  | 'needs_review'
  | 'ignored';

export type EntryPointType = 'trace' | 'alert' | 'standalone' | 'proactive';

export interface IToolCall {
  name: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
}

export interface IInvestigationMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: IToolCall[];
  timestamp: Date;
}

export interface IInvestigationExport {
  format: 'markdown' | 'json';
  content: string;
  createdAt: Date;
}

export type LoopPhase =
  | 'plan'
  | 'execute'
  | 'verify'
  | 'summarize'
  | 'complete';

export interface ILoopPhaseHistory {
  phase: LoopPhase;
  input: string;
  output: string;
  toolCalls: number;
  summaryText?: string;
  completedAt: Date;
}

export interface IToolCallEntry {
  callIndex: number;
  phase: LoopPhase;
  tool: string;
  args: Record<string, unknown>;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

export interface IThinkingEntry {
  phase: LoopPhase;
  tokenCount: number;
  content: string;
}

export interface ILoopState {
  currentPhase: LoopPhase;
  plan: string | null;
  evidence: string | null;
  verification: string | null;
  phaseHistory: ILoopPhaseHistory[];
  toolCallLog: IToolCallEntry[];
  thinkingLog: IThinkingEntry[];
}

export interface IInvestigationArtifact {
  type: 'savedSearch' | 'dashboard' | 'alert';
  id: string;
  purpose: string;
}

export interface IInvestigation {
  _id: ObjectId;
  team: ObjectId;
  createdBy: ObjectId;
  title: string;
  status: InvestigationStatus;
  entryPoint: {
    type: EntryPointType;
    traceId?: string;
    alertId?: ObjectId;
  };
  messages: IInvestigationMessage[];
  summary?: string;
  sharedWith?: ObjectId[];
  exports?: IInvestigationExport[];
  loopState?: ILoopState;
  // Proactive investigation fields
  source?: 'alert' | 'anomaly';
  sourceRef?: string;
  fingerprint?: string;
  reopenedFrom?: ObjectId;
  leaseExpiresAt?: Date;
  attemptCount?: number;
  lastError?: string;
  artifacts?: IInvestigationArtifact[];
  budget?: { startedAt?: Date; tokenUsed?: number; toolCalls?: number };
  createdAt: Date;
  updatedAt: Date;
}

const ToolCallSchema = new Schema(
  {
    name: { type: String, required: true },
    args: { type: Schema.Types.Mixed, default: {} },
    result: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false },
);

const MessageSchema = new Schema(
  {
    role: {
      type: String,
      enum: ['user', 'assistant', 'tool'],
      required: true,
    },
    content: { type: String, required: true },
    toolCalls: { type: [ToolCallSchema], default: undefined },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const ExportSchema = new Schema(
  {
    format: { type: String, enum: ['markdown', 'json'], required: true },
    content: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const LoopPhaseHistorySchema = new Schema(
  {
    phase: {
      type: String,
      enum: ['plan', 'execute', 'verify', 'summarize', 'complete'],
      required: true,
    },
    input: { type: String, required: true },
    output: { type: String, required: true },
    toolCalls: { type: Number, default: 0 },
    summaryText: { type: String },
    completedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const LoopStateSchema = new Schema(
  {
    currentPhase: {
      type: String,
      enum: ['plan', 'execute', 'verify', 'summarize', 'complete'],
      default: 'plan',
    },
    plan: { type: String, default: null },
    evidence: { type: String, default: null },
    verification: { type: String, default: null },
    phaseHistory: { type: [LoopPhaseHistorySchema], default: [] },
    toolCallLog: { type: Schema.Types.Mixed, default: [] },
    thinkingLog: { type: Schema.Types.Mixed, default: [] },
  },
  { _id: false },
);

const ArtifactSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['savedSearch', 'dashboard', 'alert'],
      required: true,
    },
    id: { type: String, required: true },
    purpose: { type: String, required: true },
  },
  { _id: false },
);

const InvestigationSchema = new Schema<IInvestigation>(
  {
    team: { type: Schema.Types.ObjectId, ref: 'Team', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true },
    status: {
      type: String,
      enum: [
        'active',
        'resolved',
        'exported',
        'pending',
        'failed',
        'needs_review',
        'ignored',
      ],
      default: 'active',
    },
    entryPoint: {
      type: {
        type: String,
        enum: ['trace', 'alert', 'standalone', 'proactive'],
        required: true,
      },
      traceId: { type: String },
      alertId: { type: Schema.Types.ObjectId },
    },
    messages: { type: [MessageSchema], default: [] },
    summary: { type: String },
    sharedWith: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    exports: { type: [ExportSchema], default: undefined },
    loopState: { type: LoopStateSchema, default: () => ({}) },
    // Proactive investigation fields
    source: { type: String, enum: ['alert', 'anomaly'], required: false },
    sourceRef: { type: String, required: false },
    fingerprint: { type: String, required: false },
    reopenedFrom: {
      type: Schema.Types.ObjectId,
      ref: 'Investigation',
      required: false,
    },
    leaseExpiresAt: { type: Date, required: false },
    attemptCount: { type: Number, required: false },
    lastError: { type: String, required: false },
    artifacts: { type: [ArtifactSchema], required: false },
    budget: { type: Schema.Types.Mixed, required: false },
  },
  { timestamps: true },
);

// Index for team-scoped queries
InvestigationSchema.index({ team: 1, createdAt: -1 });
InvestigationSchema.index({ team: 1, status: 1 });
InvestigationSchema.index({ sharedWith: 1 });
InvestigationSchema.index({ team: 1, fingerprint: 1 });

const Investigation = mongoose.model<IInvestigation>(
  'Investigation',
  InvestigationSchema,
);

export default Investigation;
