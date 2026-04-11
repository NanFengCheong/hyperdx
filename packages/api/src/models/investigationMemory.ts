import mongoose, { Schema } from 'mongoose';

import type { ObjectId } from '.';

export interface IInvestigationMemoryFinding {
  service: string;
  symptom: string;
  rootCause: string;
  confidence: 'high' | 'medium' | 'low';
  wasVerified: boolean;
}

export interface IInvestigationMemoryArtifact {
  type: 'savedSearch' | 'dashboard' | 'alert';
  id: string;
  purpose: string;
}

export interface IInvestigationMemoryBaseline {
  errorRate: number;
  latencyP50: number;
  latencyP99: number;
  throughput: number;
  measuredAt: Date;
}

export interface IInvestigationMemory {
  _id: ObjectId;
  teamId: string;
  investigationId: ObjectId;
  findings: IInvestigationMemoryFinding[];
  artifactsCreated: IInvestigationMemoryArtifact[];
  resolvedAt: Date;
  recurrenceCount: number;
  baselineMetrics: Record<string, IInvestigationMemoryBaseline>;
  triggerType: 'health_scan' | 'alert' | 'trend_review' | 'standalone';
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  fingerprint?: string;
  rootCause?: string;
  createdAt: Date;
}

const FindingSchema = new Schema<IInvestigationMemoryFinding>(
  {
    service: { type: String, required: true },
    symptom: { type: String, required: true },
    rootCause: { type: String, required: true },
    confidence: {
      type: String,
      enum: ['high', 'medium', 'low'],
      required: true,
    },
    wasVerified: { type: Boolean, default: false },
  },
  { _id: false },
);

const ArtifactSchema = new Schema<IInvestigationMemoryArtifact>(
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

const BaselineSchema = new Schema<IInvestigationMemoryBaseline>(
  {
    errorRate: { type: Number, required: true },
    latencyP50: { type: Number, required: true },
    latencyP99: { type: Number, required: true },
    throughput: { type: Number, required: true },
    measuredAt: { type: Date, required: true },
  },
  { _id: false },
);

const InvestigationMemorySchema = new Schema<IInvestigationMemory>(
  {
    teamId: { type: String, required: true, index: true },
    investigationId: {
      type: Schema.Types.ObjectId,
      ref: 'Investigation',
      required: true,
    },
    findings: { type: [FindingSchema], default: [] },
    artifactsCreated: { type: [ArtifactSchema], default: [] },
    resolvedAt: { type: Date, required: true, index: true },
    recurrenceCount: { type: Number, default: 0 },
    baselineMetrics: {
      type: Schema.Types.Mixed,
      default: {},
    },
    triggerType: {
      type: String,
      enum: ['health_scan', 'alert', 'trend_review', 'standalone'],
      required: true,
    },
    summary: { type: String, required: true },
    confidence: {
      type: String,
      enum: ['high', 'medium', 'low'],
      required: true,
    },
    fingerprint: { type: String, required: false },
    rootCause: { type: String, required: false },
  },
  { timestamps: true },
);

// Index for efficient retrieval by team + service pattern
InvestigationMemorySchema.index({ teamId: 1, 'findings.service': 1 });
InvestigationMemorySchema.index({ teamId: 1, resolvedAt: -1 });
InvestigationMemorySchema.index({
  teamId: 1,
  'findings.symptom': 'text',
  summary: 'text',
});
InvestigationMemorySchema.index({ teamId: 1, fingerprint: 1 });

const InvestigationMemory = mongoose.model<IInvestigationMemory>(
  'InvestigationMemory',
  InvestigationMemorySchema,
);

export default InvestigationMemory;
