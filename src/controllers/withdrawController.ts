import { FastifyReply, FastifyRequest } from 'fastify';
import { setWallet } from '../services/walletService';
import { DEFAULT_CHAIN_ID } from '../constants/environment';
import Token from '../models/token';
import { generateUserWallet} from "../controllers/swapController"
import { setupERC20 } from '../services/walletService';

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
    const { signer, proxyAddress } = await generateUserWallet(channel_user_id);
    if (!dst_address.startsWith('0x')) {
        return reply.status(400).send({ message: 'Invalid destination address' });
    }
    const wallet = setWallet(channel_user_id, chain_id);
    try {
        await wallet.withdrawFunds(dst_address);
    } catch (error) {
        console.warn("Function 'withdrawFunds' does not exists:", error);

        const tokens = await Token.find({ chain_id });
        let txs = [];
        tokens.map(async (token) => {
            const tokenContract = await setupERC20(token.address, signer);
            try {
                const tx = await tokenContract.transfer(dst_address, await tokenContract.balanceOf(proxyAddress));
                const txHash = await tx.wait()
                txs.push(txHash);
            } catch (error) {
                console.error('Error transferring funds:', error);
            }

        });
    } finally {
        return reply.send({ message: 'Funds are in process of withdraw' });
    }
}