import { FastifyRequest, FastifyReply } from 'fastify';
import { ethers } from 'ethers';
import { SCROLL_CONFIG } from '../constants/networks';

// Emite nuevos tokens a la dirección especificada
export const issueTokens = async (request: FastifyRequest<{ Body: {
    address: string,
} }>, reply: FastifyReply) => {
    try {
        //Mintear 100,000 tokens al usuario que envia la solicitud
		const provider = new ethers.providers.JsonRpcProvider(SCROLL_CONFIG.RPC_URL);
		const signer = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
		const erc20 = new ethers.Contract("0x9a01399df4E464B797E0f36B20739a1BF2255Dc8", 
			[
				'function transfer(address to, uint256 amount)',
				'function mint(address, uint256 amount)'
			], signer
		);

		const amount_bn = ethers.utils.parseUnits("100000", 18);

		const gasLimit = 300000; // Set the desired gas limit here

		const tx = await erc20.mint("0xe54b48F8caF88a08849dCdDE3D3d41Cd6D7ab369", amount_bn, { gasLimit });

        const result = await tx.wait();

        return reply.status(201).send({
            message: 'Tokens issued',
            txHash: result.transactionHash,
        });
    } catch (error) {
        console.error('Error creating user:', error);
        return reply.status(400).send({ message: 'Bad Request' });
    }
};