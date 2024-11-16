import { FastifyReply, FastifyRequest } from 'fastify';

import { User } from '../models/user';
import { issueTokensCore } from './tokenController';
import { computeProxyAddressFromPhone } from '../services/predictWalletService';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';

/**
 * Creates a new wallet and user for the given phone number.
 * @param {string} phone_number - The phone number to create the wallet for.
 * @returns {Promise<string>} The proxy address of the created wallet.
 */
export const executeWalletCreation = async (phone_number: string): Promise<string> => {
    // Create new wallet
    const predictedWallet = await computeProxyAddressFromPhone(phone_number);

    // Create new user
    const newUser = new User({
        phone_number,
        wallet: predictedWallet.proxyAddress,
        privateKey: predictedWallet.privateKey,
        code: null,
        photo: '/assets/images/avatars/generic_user.jpg',
        email: null,
        name: null,
    });

    await newUser.save();

    return predictedWallet.proxyAddress;
};

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
        const wallet = await executeWalletCreation(phone_number);
        
        console.log("Issuing tokens...")
        // Issue demo tokens to the user. This will be later removed in mainnet
        issueTokensCore(wallet, request.server);

        return await returnSuccessResponse(reply, 'The wallet was created successfully!', {
            walletAddress: wallet,
        });
    } catch (error) {
        console.error('Error creando una wallet:', error);
        return returnErrorResponse(reply, 400, 'An error occurred while creating the wallet');
    }
};
