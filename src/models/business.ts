import { model, Schema, Document } from 'mongoose';

export interface IBusiness extends Document {
    phoneNumber: string;
    name: string;
    photo: string;
    owner: Schema.Types.ObjectId;
    createdAt: Date;
}

const businessSchema = new Schema<IBusiness>({
    phoneNumber: { type: String, required: true },
    name: { type: String, required: true },
    photo: { type: String, required: true },
    owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    createdAt: { type: Date, default: Date.now }
});

export const Business = model<IBusiness>('Business', businessSchema);