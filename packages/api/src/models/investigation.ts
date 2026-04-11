import mongoose, { Schema } from 'mongoose';

import type { ObjectId } from '.';

export type InvestigationStatus = 'active' | 'resolved' | 'exported';

export type EntryPointType = 'trace' | 'alert' | 'standalone';

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

export interface ILoopState {
  currentPhase: LoopPhase;
  plan: string | null;
  evidence: string | null;
  verification: string | null;
  phaseHistory: ILoopPhaseHistory[];
  toolCallLog: IToolCallEntry[];
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
      enum: ['active', 'resolved', 'exported'],
      default: 'active',
    },
    entryPoint: {
      type: {
        type: String,
        enum: ['trace', 'alert', 'standalone'],
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
  },
  { timestamps: true },
);

// Index for team-scoped queries
InvestigationSchema.index({ team: 1, createdAt: -1 });
InvestigationSchema.index({ team: 1, status: 1 });
InvestigationSchema.index({ sharedWith: 1 });

const Investigation = mongoose.model<IInvestigation>(
  'Investigation',
  InvestigationSchema,
);

export default Investigation;
