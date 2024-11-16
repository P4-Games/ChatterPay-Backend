import { FastifyReply, FastifyRequest } from 'fastify';

import { User } from '../models/user';
import { generateToken } from '../utils/jwt';
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
        const user = await User.findOne({ phone_number: request.body.channel_user_id });

        if (!user) {
            console.warn("User not found");
            return await returnErrorResponse(reply, 404, 'User not found');
        }

        // Generate a random 6 digit numeric code
        const randomCode = Math.floor(100000 + Math.random() * 900000);
        
        // Update the user code field optimistically with the generated code
        await User.findByIdAndUpdate(user?._id, { code: randomCode });

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
            code: number
        }
    }>,
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        // Find user by channel_user_id
        const user = await User.find({ phone_number: request.body.channel_user_id });

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
            access_token: generateToken({
                appName: 'chatterpay-sdk',
                channelUserId: request.body.channel_user_id,
                userId: user[0].id,
            }),
            user: {
                id: user[0].id,
                status: 'verified',
            }
        });

    } catch (error) {
        console.error('Error verifying connection:', error);
        return returnErrorResponse(reply, 500, 'Internal server error');
    }
}