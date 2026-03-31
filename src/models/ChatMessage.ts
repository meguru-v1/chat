import mongoose, { Schema, Document } from 'mongoose';

export interface IChatMessage extends Document {
  sessionId: string;
  messageId: string;
  timestamp: Date;
  authorName: string;
  message: string;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    sessionId: { type: String, required: true, index: true },
    messageId: { type: String, required: true, unique: true },
    timestamp: { type: Date, required: true },
    authorName: { type: String, required: true },
    message: { type: String, required: true },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

ChatMessageSchema.index({ sessionId: 1, timestamp: 1 });

export const ChatMessage = mongoose.model<IChatMessage>(
  'ChatMessage',
  ChatMessageSchema
);
