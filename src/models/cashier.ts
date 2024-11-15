import { model, Schema } from "mongoose";

export interface ICashier extends Document {
    name: string;
    uniqueId: string;
    business: Schema.Types.ObjectId;
    active: boolean;
    createdAt: Date;
}

const cashierSchema = new Schema<ICashier>({
    name: { type: String, required: true },
    uniqueId: { type: String, required: true, unique: true },
    business: { type: Schema.Types.ObjectId, ref: 'Business', required: true },
    active: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

export const Cashier = model<ICashier>('Cashier', cashierSchema);