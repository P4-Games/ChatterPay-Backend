import { FastifyReply, FastifyRequest } from 'fastify';

import { User } from '../models/user';
import { sendVerificationCode } from './replyController';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

/**
 * Creates a new cashier record in the database
 * Takes cashier details in the request body and saves them
 * Returns the newly created cashier on success
 */
export const connectWithChatterPayAccount = async (
    request: FastifyRequest<{ Body: {
        channel_user_id: string,
        app_name: string,
    } }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        // Find user account
        const user = await User.find({ channel_user_id: request.body.channel_user_id });

        if (!user) {
            console.warn("User not found");
            return await returnErrorResponse(reply, 404, 'User not found');
        }

        // Generate a random 6 digit numeric code
        const randomCode = Math.floor(100000 + Math.random() * 900000);
        
        // Update the user code field optimistically with the generated code
        User.findByIdAndUpdate(user?.[0]?.id, { code: randomCode }, { new: true });

        // Send message with the code
        sendVerificationCode(request.body.channel_user_id, randomCode, request.body.app_name);

        return await returnSuccessResponse(reply, 'Code sent successfully', { ok: true });
    } catch (error) {
        console.error('Error creating cashier:', error);
        return returnErrorResponse(reply, 400, 'Bad Request');
    }
};

export const verifyConnect = async (
    request: FastifyRequest<{
        Body: {
            channel_user_id: string,
            code: number,
            app_name: string
        }
    }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        // Find user by channel_user_id
        const user = await User.find({ channel_user_id: request.body.channel_user_id });

        if (!user?.[0]) {
            return await returnErrorResponse(reply, 404, 'User not found');
        }

        // Verify code matches
        if (user[0].code !== request.body.code) {
            return await returnErrorResponse(reply, 400, 'Invalid verification code');
        }

        // Update user status and clear code
        User.findByIdAndUpdate(user[0].id, {
            code: null,
        });

        return await returnSuccessResponse(reply, 'Account verified successfully', {
            ok: true,
            user: {
                id: user[0].id,
                status: 'verified',
                app_name: request.body.app_name
            }
        });

    } catch (error) {
        console.error('Error verifying connection:', error);
        return returnErrorResponse(reply, 500, 'Internal server error');
    }
}