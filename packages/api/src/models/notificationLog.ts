import mongoose, { Document } from 'mongoose';

export interface INotificationLog extends Document {
  teamId: mongoose.Types.ObjectId;
  channel: 'email' | 'webhook';
  status: 'pending' | 'success' | 'failed';
  recipient: string;
  trigger: {
    type: string;
    id: string;
    name: string;
  };
  subject: string;
  payload: Record<string, unknown>;
  response: Record<string, unknown>;
  error: string | null;
  retryOf: mongoose.Types.ObjectId | null;
  actorId: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

const NotificationLogSchema = new mongoose.Schema<INotificationLog>(
  {
    teamId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Team',
      required: true,
    },
    channel: {
      type: String,
      required: true,
      enum: ['email', 'webhook'],
    },
    status: {
      type: String,
      required: true,
      enum: ['pending', 'success', 'failed'],
      default: 'pending',
    },
    recipient: {
      type: String,
      required: true,
    },
    trigger: {
      type: {
        type: String,
        required: true,
      },
      id: {
        type: String,
        required: true,
      },
      name: {
        type: String,
        required: true,
      },
    },
    subject: {
      type: String,
      required: true,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    response: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    error: {
      type: String,
      default: null,
    },
    retryOf: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'NotificationLog',
      default: null,
    },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  },
);

// Team-scoped queries with date range
NotificationLogSchema.index({ teamId: 1, createdAt: -1 });
// Team-scoped channel filtering
NotificationLogSchema.index({ teamId: 1, channel: 1, createdAt: -1 });
// Team-scoped status filtering
NotificationLogSchema.index({ teamId: 1, status: 1, createdAt: -1 });
// Recipient search
NotificationLogSchema.index({ recipient: 1, createdAt: -1 });
// Trigger lookup
NotificationLogSchema.index({ 'trigger.type': 1, 'trigger.id': 1 });
// Retry chain
NotificationLogSchema.index({ retryOf: 1 });
// Global date range (admin + retention cleanup)
NotificationLogSchema.index({ createdAt: -1 });

export default mongoose.model<INotificationLog>(
  'NotificationLog',
  NotificationLogSchema,
);
