import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest } from 'fastify';

import NFTModel, { getLastId } from '../models/nft';
import { getWalletByPhoneNumber } from '../models/user';
import { getNetworkConfig } from '../services/networkService';
import { downloadAndProcessImage, uploadToICP, uploadToIpfs } from '../utils/uploadServices';
import { executeWalletCreation } from './newWalletController';
import { sendMintNotification } from './replyController';
import { issueTokensCore } from './tokenController';

export interface NFTInfo {
    description: string;
    url: string;
}

/**
 * Mints an NFT on the Ethereum network.
 * @param {string} recipientAddress - The address to receive the minted NFT.
 * @param {number} tokenURI - The token URI for the NFT.
 * @returns {Promise<ethers.ContractReceipt>} The transaction receipt.
 * @throws {Error} If minting fails.
 */
const mint_eth_nft = async (
    recipientAddress: string,
    tokenURI: number,
): Promise<ethers.ContractReceipt> => {
    try {
        const networkConfig = await getNetworkConfig(421614); // arbitrum sepolia
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
        const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
            const nftContract = new ethers.Contract(
            networkConfig.chatterNFTAddress,
            ['function safeMint(address to, string memory uri) public returns (uint256)'],
            backendSigner,
        );
    
        console.log('Safe minting...')
        const tx = await nftContract.safeMint(recipientAddress, tokenURI, {
            gasLimit: 500000,
        });

        console.log('Transaction sent: ', tx.hash);

        const receipt = await tx.wait();
        console.log('Transaction confirmed: ', receipt.transactionHash);

        return receipt;
    } catch (error) {
        console.error('Error minting NFT: ', error);
        throw new Error('Minting failed');
    }
};

/**
 * Handles the minting of a new NFT.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<boolean>} True if minting was successful.
 */
export const mintNFT = async (
    request: FastifyRequest<{
        Body: {
            channel_user_id: string;
            url: string;
            mensaje: string;
            geolocation?: string;
        };
    }>,
    reply: FastifyReply,
): Promise<boolean> => {
    const { channel_user_id, url, mensaje } = request.body;
    const address_of_user = await getWalletByPhoneNumber(channel_user_id);

    if (!address_of_user) {
        reply.status(400).send({ message: 'La wallet del usuario no existe.' });
        return false;
    }

    reply.status(200).send({ message: 'El certificado en NFT está siendo generado...' });

    const new_id = (await getLastId()) + 1;

    let data;
    try {
        data = await mint_eth_nft(address_of_user, new_id);
    } catch (error) {
        console.error('Error al mintear NFT:', error);
        throw error
    }

    const fileName = `photo_${new_id}_${Date.now()}.jpg`;
    let processedImage
    let ipfsImageUrl = ''
    let icpImageUrl = '' 
    try {
        processedImage = await downloadAndProcessImage(url);
    } catch (error) {
        console.error('Error al descargar la imagen del NFT:', error);
        throw error
    }


    try {
        ipfsImageUrl = await uploadToIpfs(processedImage, fileName);
    } catch (error) {
        console.error('Error al subir la imagen a IPFS', error);
        // no throw error!
    }

    try {
        icpImageUrl = await uploadToICP(processedImage, fileName);
    } catch (error) {
        console.error('Error al subir la imagen a ICP', error);
        // no throw error!
    }

    await NFTModel.create({
        id: new_id,
        channel_user_id,
        wallet: address_of_user,
        trxId: data.transactionHash,
        copy_of: null,
        original: true,
        timestamp: new Date(),
        metadata: {
            image_url: {
                gcp: url || '',
                icp: icpImageUrl! || '',
                ipfs: ipfsImageUrl! || '',
            },
            description: mensaje,
            geolocation: request.body.geolocation || null,
        },
    });

    sendMintNotification(channel_user_id, new_id);

    return true;
};

/**
 * Mints an existing NFT for a user.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<boolean>} True if minting was successful.
 */
export const mintExistingNFT = async (
    request: FastifyRequest<{
        Body: {
            channel_user_id: string;
            id: string;
        };
    }>,
    reply: FastifyReply,
): Promise<boolean> => {
    const { channel_user_id, id } = request.body;

    let address_of_user = await getWalletByPhoneNumber(channel_user_id);

    if (!address_of_user) {
        console.log('La wallet del usuario no existe. Creando...');
        address_of_user = await executeWalletCreation(channel_user_id);

        // Issue demo tokens to the user. This will be later removed in mainnet
        issueTokensCore(address_of_user);
    }

    reply.status(200).send({ message: 'El certificado en NFT está siendo generado...' });

    const nft = await NFTModel.find({ id: parseInt(id, 10) });

    if (!nft) {
        reply.status(400).send({ message: 'El NFT no existe.' });
        return false;
    }
    const new_id = (await getLastId()) + 1;

    let data;
    try {
        data = await mint_eth_nft(address_of_user, new_id);
    } catch (error) {
        console.error('Error al mintear NFT:', error);
        throw error
    }

    await NFTModel.create({
        id: new_id,
        channel_user_id,
        copy_of: nft?.[0]?.id,
        original: false,
        timestamp: new Date(),
        wallet: address_of_user,
        trxId: data.transactionHash,
        metadata: nft?.[0]?.metadata ? nft?.[0]?.metadata : 
        {
            image_url: {
                gcp: '',
                icp: '',
                ipfs: '',
            },
            description: '',
            geolocation: null
        }
    });

    sendMintNotification(channel_user_id, new_id);

    return true;
};

/**
 * Retrieves an NFT by its ID.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 */
export const getNFT = async (
    request: FastifyRequest<{
        Params: {
            id: number;
        };
    }>,
    reply: FastifyReply,
): Promise<void> => {
    try {
        const { id } = request.params;

        const nft = (await NFTModel.find({ id }))?.[0];

        if (nft) {
            reply.send({
                image: nft.metadata.image_url,
                description: nft.metadata.description,
            });
        } else {
            reply.status(404).send({ message: 'NFT not found' });
        }
    } catch (error) {
        console.error('Error al obtener el NFT:', error);
        reply.status(500).send({ message: 'Internal Server Error' });
    }
};

/**
 * Retrieves the last NFT for a user and redirects to a WhatsApp link.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 */
export const getLastNFT = async (
    request: FastifyRequest<{
        Querystring: {
            channel_user_id: string;
        };
    }>,
    reply: FastifyReply,
): Promise<void> => {
    try {
        const { channel_user_id } = request.query;

        const nft = (await NFTModel.find({ channel_user_id })).sort((a, b) => b.id - a.id)?.[0];

        if (nft) {
            reply.redirect(
                `https://api.whatsapp.com/send/?phone=5491164629653&text=Me%20gustar%C3%ADa%20mintear%20el%20NFT%20${nft.id}`,
            );
        } else {
            reply.status(404).send({ message: 'NFT not found' });
        }
    } catch (error) {
        console.error('Error al obtener el NFT:', error);
        reply.status(500).send({ message: 'Internal Server Error' });
    }
};

/**
 * Retrieves all NFTs for a given phone number.
 * @param {string} phone_number - The phone number to retrieve NFTs for.
 * @returns {Promise<{count: number, nfts: NFTInfo[]}>} The count and list of NFTs.
 * @throws {Error} If there's an error retrieving the NFTs.
 */
export const getPhoneNFTs = async (
    phone_number: string,
): Promise<{ count: number; nfts: NFTInfo[] }> => {
    try {
        const networkConfig = await getNetworkConfig(421614);
        const nfts = await NFTModel.find({ channel_user_id: phone_number });

        return {
            count: nfts.length,
            nfts: nfts.map((nft) => ({
                description: nft.metadata.description,
                url: `https://testnets.opensea.io/assets/arbitrum-sepolia/${networkConfig.chatterNFTAddress}/${nft.id}`,
            })),
        };
    } catch (error) {
        console.error('Error al obtener los NFTs:', error);
        throw new Error('Internal Server Error');
    }
};

/**
 * Retrieves all NFTs for a given user.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<{count: number, nfts: NFTInfo[]}>} The count and list of NFTs.
 */
export const getAllNFTs = async (
    request: FastifyRequest<{ Querystring: { channel_user_id: string } }>,
    reply: FastifyReply,
): Promise<{ count: number; nfts: NFTInfo[] }> => {
    const { channel_user_id: phone_number } = request.query;

    const result = await getPhoneNFTs(phone_number);

    return reply.status(200).send(result);
};
