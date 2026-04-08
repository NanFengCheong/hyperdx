import mongoose, { Document } from 'mongoose';

export interface IAuditLog extends Document {
  teamId: mongoose.Types.ObjectId;
  actorId: mongoose.Types.ObjectId;
  actorEmail: string;
  action: string;
  targetType: string;
  targetId: string;
  details: Record<string, unknown>;
}

const AuditLogSchema = new mongoose.Schema<IAuditLog>(
  {
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    actorEmail: {
      type: String,
    },
    action: {
      type: String,
      required: true,
    },
    targetType: {
      type: String,
      required: true,
    },
    targetId: {
      type: String,
      required: true,
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Team-scoped queries with date range (GET /team/audit-log)
AuditLogSchema.index({ teamId: 1, createdAt: -1 });

// Team-scoped action filtering
AuditLogSchema.index({ teamId: 1, action: 1 });

// Global date-range queries across all teams (GET /admin/audit-log?fromDate=&toDate=)
// Also supports data retention deleteMany({ createdAt: { $lt: cutoff } })
AuditLogSchema.index({ createdAt: -1 });

// Actor email filter + date range + sort (GET /admin/audit-log?actorEmail=)
AuditLogSchema.index({ actorEmail: 1, createdAt: -1 });

export default mongoose.model<IAuditLog>('AuditLog', AuditLogSchema);
