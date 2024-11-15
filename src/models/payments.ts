import { model, Schema } from "mongoose";

export interface IPaymentOrder extends Document {
    amount: number;
    currency: string;
    status: 'pending' | 'completed' | 'failed';
    network: string;
    cashier: Schema.Types.ObjectId;
    customerPhone?: string;
    transactionHash?: string;
    createdAt: Date;
}

const paymentOrderSchema = new Schema<IPaymentOrder>({
    amount: { type: Number, required: true },
    currency: { type: String, default: 'USDC' },
    status: { 
        type: String, 
        enum: ['pending', 'completed', 'failed'],
        default: 'pending'
    },
    network: { type: String, required: true },
    cashier: { type: Schema.Types.ObjectId, ref: 'Cashier', required: true },
    customerPhone: { type: String },
    transactionHash: { type: String },
    createdAt: { type: Date, default: Date.now }
});

export const PaymentOrder = model<IPaymentOrder>('PaymentOrder', paymentOrderSchema);