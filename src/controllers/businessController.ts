import { FastifyReply, FastifyRequest } from 'fastify';

import { Business, IBusiness } from '../models/business';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

export const createBusiness = async (
    request: FastifyRequest<{ Body: IBusiness }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const newBusiness = new Business(request.body);
        await newBusiness.save();
        return await returnSuccessResponse(reply, 'Business created successfully', { business: newBusiness });
    } catch (error) {
        console.error('Error creating business:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};

export const getAllBusinesses = async (
    request: FastifyRequest,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const businesses = await Business.find();
        return await returnSuccessResponse(reply, 'Businesses fetched successfully', { businesses });
    } catch (error) {
        console.error('Error fetching businesses:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch businesses');
    }
};

export const getBusinessById = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const business = await Business.findById(request.params.id);
        if (!business) return await returnErrorResponse(reply, 404, 'Business not found');
        return await returnSuccessResponse(reply, 'Business fetched successfully', { business });
    } catch (error) {
        console.error('Error fetching business:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch business');
    }
};

export const getBusinessByPhone = async (
    request: FastifyRequest<{ Params: { phone: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const business = await Business.findOne({ phoneNumber: request.params.phone });
        if (!business) return await returnErrorResponse(reply, 404, 'Business not found');
        return await returnSuccessResponse(reply, 'Business fetched successfully', { business });
    } catch (error) {
        console.error('Error fetching business:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch business');
    }
};

export const updateBusiness = async (
    request: FastifyRequest<{ 
        Params: { id: string };
        Body: Partial<IBusiness>;
    }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const updatedBusiness = await Business.findByIdAndUpdate(
            request.params.id,
            request.body,
            { new: true }
        );
        if (!updatedBusiness) return await returnErrorResponse(reply, 404, 'Business not found');
        return await returnSuccessResponse(reply, 'Business updated successfully', { business: updatedBusiness });
    } catch (error) {
        console.error('Error updating business:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};

export const deleteBusiness = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const deletedBusiness = await Business.findByIdAndDelete(request.params.id);
        if (!deletedBusiness) return await returnErrorResponse(reply, 404, 'Business not found');
        return await returnSuccessResponse(reply, 'Business deleted successfully');
    } catch (error) {
        console.error('Error deleting business:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};