import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest } from 'fastify';

import Token, { IToken } from '../models/token';
import { getNetworkConfig } from '../services/networkService';
import { USDT_ADDRESS, WETH_ADDRESS } from '../constants/contracts';

/**
 * Creates a new token
 * @param {FastifyRequest<{ Body: IToken }>} request - The Fastify request object containing the token data in the body
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object
 */
export const createToken = async (request: FastifyRequest<{ Body: IToken }>, reply: FastifyReply): Promise<FastifyReply> => {
  try {
    const newToken = new Token(request.body);
    await newToken.save();
    return await reply.status(201).send(newToken);
  } catch (error) {
    console.error('Error creating token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Retrieves all tokens
 * @param {FastifyRequest} request - The Fastify request object
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing all tokens
 */
export const getAllTokens = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
  try {
    const tokens = await Token.find();
    return await reply.status(200).send(tokens);
  } catch (error) {
    console.error('Error fetching tokens:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Retrieves a token by its ID
 * @param {FastifyRequest<{ Params: { id: string } }>} request - The Fastify request object containing the token ID in the params
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the found token or an error message
 */
export const getTokenById = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const token = await Token.findById(id);

    if (!token) {
      return await reply.status(404).send({ message: 'Token not found' });
    }

    return await reply.status(200).send(token);
  } catch (error) {
    console.error('Error fetching token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Updates a token by its ID
 * @param {FastifyRequest<{ Params: { id: string }, Body: Partial<IToken> }>} request - The Fastify request object containing the token ID in the params and update data in the body
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing the updated token or an error message
 */
export const updateToken = async (request: FastifyRequest<{ Params: { id: string }, Body: Partial<IToken> }>, reply: FastifyReply): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const updatedToken = await Token.findByIdAndUpdate(id, request.body, { new: true });

    if (!updatedToken) {
      return await reply.status(404).send({ message: 'Token not found' });
    }

    return await reply.status(200).send(updatedToken);
  } catch (error) {
    console.error('Error updating token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Deletes a token by its ID
 * @param {FastifyRequest<{ Params: { id: string } }>} request - The Fastify request object containing the token ID in the params
 * @param {FastifyReply} reply - The Fastify reply object
 * @returns {Promise<FastifyReply>} A promise that resolves to the Fastify reply object containing a success message or an error message
 */
export const deleteToken = async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply): Promise<FastifyReply> => {
  const { id } = request.params as { id: string };

  try {
    const deletedToken = await Token.findByIdAndDelete(id);

    if (!deletedToken) {
      return await reply.status(404).send({ message: 'Token not found' });
    }

    return await reply.status(200).send({ message: 'Token deleted' });
  } catch (error) {
    console.error('Error deleting token:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};

/**
 * Represents the result of a token minting operation.
 */
interface MintResult {
  /** The address of the token contract */
  tokenAddress: string;
  /** The transaction hash of the minting operation */
  txHash: string;
}

/**
 * Mints a specified amount of tokens for a given address.
 * 
 * @param signer - The ethers.Wallet instance used to sign the transaction
 * @param tokenAddress - The address of the token contract
 * @param recipientAddress - The address to receive the minted tokens
 * @param amount - The amount of tokens to mint (as a string)
 * @param nonce - The nonce to use for the transaction
 * @returns A promise that resolves to a MintResult object
 */
async function mintToken(
  signer: ethers.Wallet,
  tokenAddress: string,
  recipientAddress: string,
  amount: string,
  nonce: number
): Promise<MintResult> {
  const erc20: ethers.Contract = new ethers.Contract(
    tokenAddress,
    ['function mint(address to, uint256 amount)'],
    signer
  );

  const amountBN: ethers.BigNumber = ethers.utils.parseUnits(amount, 18);
  const gasLimit: number = 5000000; // Set a reasonable gas limit

  // Estimate gas price
  const gasPrice: ethers.BigNumber = await signer.provider!.getGasPrice();

  // Increase gas price by 20% to ensure the transaction goes through
  const adjustedGasPrice: ethers.BigNumber = gasPrice.mul(120).div(100);

  const tx: ethers.ContractTransaction = await erc20.mint(recipientAddress, amountBN, { 
    gasLimit,
    nonce,
    gasPrice: adjustedGasPrice
  });
  const result: ethers.ContractReceipt = await tx.wait();

  return {
    tokenAddress,
    txHash: result.transactionHash,
  };
}

/**
 * Issues a specified amount of USDT and WETH tokens to a given address.
 * 
 * @param request - The Fastify request object containing the recipient's address
 * @param reply - The Fastify reply object
 * @returns A promise that resolves to the Fastify reply object
 */
export const issueTokens = async (
  request: FastifyRequest<{ Body: { address: string } }>,
  reply: FastifyReply
): Promise<FastifyReply> => {
  const { address }: { address: string } = request.body;
  const tokenAddresses: string[] = [USDT_ADDRESS, WETH_ADDRESS];
  const amount: string = "1000";

  try {
    const network = await getNetworkConfig();
    const provider: ethers.providers.JsonRpcProvider = new ethers.providers.JsonRpcProvider(network.rpc);
    const signer: ethers.Wallet = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
    
    // Get the current nonce for the signer
    const currentNonce: number = await provider.getTransactionCount(signer.address);

    const mintPromises: Promise<MintResult>[] = tokenAddresses.map((tokenAddress, index) => 
      mintToken(signer, tokenAddress, address, amount, currentNonce + index)
    );

    const results: MintResult[] = await Promise.all(mintPromises);

    return await reply.status(201).send({
      message: 'Tokens minted successfully',
      results,
    });
  } catch (error) {
    console.error('Error minting tokens:', error);
    return reply.status(400).send({ message: 'Bad Request' });
  }
};