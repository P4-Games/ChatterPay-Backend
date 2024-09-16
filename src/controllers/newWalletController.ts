import { FastifyReply, FastifyRequest } from "fastify";

import { User } from "../models/user";
import { authenticate } from "./transactionController";
import { computeProxyAddressFromPhone } from "../services/predictWalletService";

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
        photo: "/assets/images/avatars/generic_user.jpg",
        email: null,
        name: null,
    });

    await newUser.save();

    return predictedWallet.proxyAddress;
}

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
    reply: FastifyReply
): Promise<FastifyReply> => {
    try {
        authenticate(request);

        const { channel_user_id } = request.body;

        const phone_number = channel_user_id;

        if (!phone_number || phone_number.length > 15) {
            return await reply.status(400).send({ message: "Número de teléfono no válido" });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ phone_number });
        if (existingUser) {
            return await reply.status(200).send({ message: `El usuario ya existe, tu wallet es ${existingUser.wallet}` });
        }

        const wallet = await executeWalletCreation(phone_number);

        return await reply.status(200).send({
            message: "La wallet fue creada exitosamente!",
            // walletHash: predictedWallet.EOAAddress,
            walletAddress: wallet
        });

    } catch (error) {
        console.error("Error creando una wallet:", error);
        return reply.status(500).send({ message: "Error interno del servidor" });
    }
};