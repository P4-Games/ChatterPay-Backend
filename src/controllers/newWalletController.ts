import { FastifyReply, FastifyRequest } from 'fastify';

import { IUser, User } from '../models/user';
import { createUserWithWallet } from '../services/userService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

/**
 * Handles the creation of a new wallet.
 * @param {FastifyRequest<{ Body: { channel_user_id: string } }>} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<FastifyReply>} The Fastify reply object.
 */
export const createWallet = async (
    request: FastifyRequest<{
        Body: {
            channel_user_id: string;
        };
    }>,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    try {
        const { channel_user_id } = request.body;

        const phone_number = channel_user_id;

        if (!phone_number || phone_number.length > 15) {
            return await returnErrorResponse(reply, 400, 'Phone number is invalid');
        }

        // Check if user already exists
        const existingUser = await User.findOne({ phone_number });
        if (existingUser) {
            return await returnSuccessResponse(
                reply,
                `The user already exists, your wallet is ${existingUser.wallet}`,
            )
        }

        console.log("Creating wallet...")
        const user: IUser = await createUserWithWallet(phone_number);
        
        // console.log("Issuing tokens...")
        // Issue demo tokens to the user. This will be later removed in mainnet
        // issueTokensCore(wallet);

        return await returnSuccessResponse(reply, 'The wallet was created successfully!', {
            walletAddress: user.walletEOA,
        });
    } catch (error) {
        console.error('Error creando una wallet:', error);
        return returnErrorResponse(reply, 400, 'An error occurred while creating the wallet');
    }
};
