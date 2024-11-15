import { FastifyReply, FastifyRequest } from 'fastify';

import { Cashier, ICashier } from '../models/cashier';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

/**
 * Creates a new cashier record in the database
 * Takes cashier details in the request body and saves them
 * Returns the newly created cashier on success
 */
export const createCashier = async (
    request: FastifyRequest<{ Body: ICashier }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const newCashier = new Cashier(request.body);
        await newCashier.save();
        return await returnSuccessResponse(reply, 'Cashier created successfully', { cashier: newCashier });
    } catch (error) {
        console.error('Error creating cashier:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};

/**
 * Retrieves all cashiers from the database
 * Returns an array of all cashier records
 */
export const getAllCashiers = async (
    request: FastifyRequest,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const cashiers = await Cashier.find();
        return await returnSuccessResponse(reply, 'Cashiers fetched successfully', { cashiers });
    } catch (error) {
        console.error('Error fetching cashiers:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch cashiers');
    }
};

/**
 * Retrieves a specific cashier by their ID
 * Returns the cashier record if found, error if not found
 */
export const getCashierById = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const cashier = await Cashier.findById(request.params.id);
        if (!cashier) return await returnErrorResponse(reply, 404, 'Cashier not found');
        return await returnSuccessResponse(reply, 'Cashier fetched successfully', { cashier });
    } catch (error) {
        console.error('Error fetching cashier:', error);
        return returnErrorResponse(reply, 400, 'Failed to fetch cashier');
    }
};

/**
 * Updates an existing cashier's information
 * Takes the cashier ID and updated fields in request
 * Returns the updated cashier record
 */
export const updateCashier = async (
    request: FastifyRequest<{ 
        Params: { id: string };
        Body: Partial<ICashier>;
    }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const updatedCashier = await Cashier.findByIdAndUpdate(
            request.params.id,
            request.body,
            { new: true }
        );
        if (!updatedCashier) return await returnErrorResponse(reply, 404, 'Cashier not found');
        return await returnSuccessResponse(reply, 'Cashier updated successfully', { cashier: updatedCashier });
    } catch (error) {
        console.error('Error updating cashier:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};

/**
 * Removes a cashier record from the database
 * Takes the cashier ID and permanently deletes the record
 * Returns success message if deleted, error if not found
 */
export const deleteCashier = async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        const deletedCashier = await Cashier.findByIdAndDelete(request.params.id);
        if (!deletedCashier) return await returnErrorResponse(reply, 404, 'Cashier not found');
        return await returnSuccessResponse(reply, 'Cashier deleted successfully');
    } catch (error) {
        console.error('Error deleting cashier:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};