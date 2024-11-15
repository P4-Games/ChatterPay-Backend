import { FastifyReply, FastifyRequest } from 'fastify';

import { Business } from '../models/business';
import { PaymentOrder, IPaymentOrder } from '../models/payments';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';
import { Cashier } from '../models/cashier';

export const createPaymentOrder = async (
    request: FastifyRequest<{ Body: IPaymentOrder }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const newPaymentOrder = new PaymentOrder(request.body);
        await newPaymentOrder.save();
        const populatedOrder = await newPaymentOrder.populate('cashier');
        return await returnSuccessResponse(reply, 'Payment order created successfully', { order: populatedOrder });
    } catch (error) {
        console.error('Error creating payment order:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};

export const getAllPaymentOrders = async (
    request: FastifyRequest,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const orders = await PaymentOrder.find().populate('cashier');
        return await returnSuccessResponse(reply, 'Payment orders fetched successfully', { orders });
    } catch (error) {
        console.error('Error fetching payment orders:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch payment orders');
    }
};

export const getPaymentOrderById = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const order = await PaymentOrder.findById(request.params.id).populate('cashier');
        if (!order) return await returnErrorResponse(reply, 404, 'Payment order not found');
        return await returnSuccessResponse(reply, 'Payment order fetched successfully', { order });
    } catch (error) {
        console.error('Error fetching payment order:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch payment order');
    }
};

export const getPaymentOrdersByCashier = async (
    request: FastifyRequest<{ Params: { cashierId: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const orders = await PaymentOrder.find({ 
            cashier: request.params.cashierId 
        }).populate('cashier').sort({ createdAt: -1 });
        return await returnSuccessResponse(reply, 'Payment orders fetched successfully', { orders });
    } catch (error) {
        console.error('Error fetching payment orders:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch payment orders');
    }
};

export const getLatestPaymentOrderByCashier = async (
    request: FastifyRequest<{ Params: { cashierId: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const order = await PaymentOrder.findOne({ 
            cashier: request.params.cashierId,
            status: 'pending'
        }).sort({ createdAt: -1 }).populate('cashier');
        if (!order) return await returnErrorResponse(reply, 404, 'No pending payment order found');
        return await returnSuccessResponse(reply, 'Payment order fetched successfully', { order });
    } catch (error) {
        console.error('Error fetching payment order:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch payment order');
    }
};

export const updatePaymentOrderStatus = async (
    request: FastifyRequest<{ 
        Params: { id: string };
        Body: { 
            status: IPaymentOrder['status'];
            transactionHash?: string;
            customerPhone?: string;
        };
    }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const updatedOrder = await PaymentOrder.findByIdAndUpdate(
            request.params.id,
            {
                status: request.body.status,
                transactionHash: request.body.transactionHash,
                customerPhone: request.body.customerPhone
            },
            { new: true }
        ).populate('cashier');
        if (!updatedOrder) return await returnErrorResponse(reply, 404, 'Payment order not found');
        return await returnSuccessResponse(reply, 'Payment order updated successfully', { order: updatedOrder });
    } catch (error) {
        console.error('Error updating payment order:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};

export const deletePaymentOrder = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const deletedOrder = await PaymentOrder.findByIdAndDelete(request.params.id);
        if (!deletedOrder) return await returnErrorResponse(reply, 404, 'Payment order not found');
        return await returnSuccessResponse(reply, 'Payment order deleted successfully');
    } catch (error) {
        console.error('Error deleting payment order:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};

export const getQRCodeDetails = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        // Get the latest pending payment order for this QR code
        console.log('Fetching QR code details:', request.params.id);
        const cashier = await Cashier.findOne({ uniqueId: request.params.id });
        if (!cashier) {
            return await returnErrorResponse(reply, 404, 'Cashier not found');
        }

        const latestPayment = await PaymentOrder.findOne({ 
            cashier: cashier._id,
            status: 'pending'
        }).sort({ createdAt: -1 });

        if (!latestPayment) {
            return await returnErrorResponse(reply, 404, 'No pending payment found for this QR code');
        }

        // Get the business details
        const business = await Business.findById(cashier.business);
        if (!business) {
            return await returnErrorResponse(reply, 404, 'Business not found');
        }

        return await returnSuccessResponse(reply, 'QR code details fetched successfully', {
            qrCodeId: request.params.id,
            payURL: `https://api.whatsapp.com/send/?phone=5491164629653&text=Hi,%20I%20confirm%20to%20pay%20the%20QR%20code%20with%20the%20ID: ${latestPayment.cashier}`,
            payment: {
                amount: latestPayment.amount,
                currency: latestPayment.currency,
                createdAt: latestPayment.createdAt
            },
            business: {
                name: business.name,
                logo: business.photo
            }
        });
    } catch (error) {
        console.error('Error fetching QR code details:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch QR code details');
    }
};