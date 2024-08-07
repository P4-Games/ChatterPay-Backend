import { FastifyRequest, FastifyReply } from "fastify";
import { computeProxyAddressFromPhone } from "../services/predictWalletService";
import User from "../models/user";
import { authenticate } from "./transactionController";

export const createWallet = async (
    request: FastifyRequest<{
        Body: {
            channel_user_id: string;
        };
    }>,
    reply: FastifyReply
) => {
    try {
        authenticate(request);

        const { channel_user_id } = request.body;

        const phone_number = channel_user_id; 

        if (!phone_number || phone_number.length > 15) {
            return reply.status(400).send({ message: "Número de teléfono no válido" });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ phone_number });
        if (existingUser) {
            return reply.status(200).send({ message: `El usuario ya existe, tu wallet es ${existingUser.wallet}`});
        }

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

        return reply.status(200).send({
            message: "La wallet fue creada exitosamente!",
            walletHash: predictedWallet.EOAAddress,
            proxyAddress: predictedWallet.proxyAddress
        });

    } catch (error) {
        console.error("Error creando una wallet:", error);
        return reply.status(500).send({ message: "Error interno del servidor" });
    }
};