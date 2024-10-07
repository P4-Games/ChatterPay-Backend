import { FastifyReply, FastifyRequest } from 'fastify';
import { setWallet } from '../services/walletService';
import { DEFAULT_CHAIN_ID } from '../constants/environment';

export async function withdrawFunds(
    request: FastifyRequest<{
        Body: {
            channel_user_id: string;
            dst_address: string;
            chain_id?: number; // Make chain_id optional
        };
    }>,
    reply: FastifyReply): Promise<FastifyReply> {

    const { channel_user_id, dst_address, chain_id = DEFAULT_CHAIN_ID } = request.body; // Set default value for chain_id
    if (!channel_user_id || !dst_address) {
        return reply.status(400).send({ message: 'Invalid parameters' });
    }
    if (!dst_address.startsWith('0x')) {
        return reply.status(400).send({ message: 'Invalid destination address' });
    }
    const wallet = setWallet(channel_user_id, chain_id);
    try {
        await wallet.withdrawFunds(dst_address);
    } catch (error) {
        console.warn("Function 'withdrawFunds' does not exists:", error);


    }
    return reply.send({ message: 'Funds are in process of withdraw' });
}