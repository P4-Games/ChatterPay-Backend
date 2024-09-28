import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest } from 'fastify';

import { issueTokensCore } from './tokenController';
import { getWalletByPhoneNumber } from '../models/user';
import { defaultNftImage } from '../constants/contracts';
import NFTModel, { INFT, INFTMetadata, getLastId } from '../models/nft';
import { getNetworkConfig } from '../services/networkService';
import { executeWalletCreation } from './newWalletController';
import { sendMintNotification, sendMintInProgressNotification } from './replyController';
import { uploadToICP, uploadToIpfs, downloadAndProcessImage } from '../utils/uploadServices';

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
    tokenURI: URL,
): Promise<ethers.ContractReceipt> => {
    try {
        const networkConfig = await getNetworkConfig(421614); // arbitrum sepolia
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
        const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);
        const nftContract = new ethers.Contract(
            networkConfig.chatterNFTAddress,
            ['function safeMint(address to, string memory uri) public returns (uint256)'],
            backendSigner,
            tokenURI.toString()
        );

        console.log(
            'nft contract: ',
            networkConfig.chatterNFTAddress,
            networkConfig.rpc,
            backendSigner.address,
        );
        console.log('Safe minting...');
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
            latitud: string;
            longitud: string;
        };
    }>,
    reply: FastifyReply,
): Promise<boolean> => {
    const { channel_user_id, url, mensaje, latitud, longitud } = request.body;

    const address_of_user = await getWalletByPhoneNumber(channel_user_id);
    if (!address_of_user) {
        reply.status(400).send({ message: 'La wallet del usuario no existe.' });
        return false;
    }

    try {
        await sendMintInProgressNotification(channel_user_id);
    } catch (error) {
        console.error('Error al enviar notificación de minteo de NFT', error.message);
        throw error;
    }

    let data;
    try {
        const nfImageURL = new URL(url ?? defaultNftImage);
        data = await mint_eth_nft(address_of_user, nfImageURL);
    } catch (error) {
        console.error('Error al mintear NFT:', error);
        throw error;
    }

    // OPTIMISTIC RESPONSE: respond quickly to the user and process the rest of the flow asynchronously.
    const new_id = (await getLastId()) + 1;
    try {
        await sendMintNotification(channel_user_id, new_id);
    } catch (error) {
        console.error('Error al enviar notificación de minteo de NFT', error.message);
        throw error;
    }

    let processedImage;
    try {
        console.info('Obteniendo imagen de NFT');
        processedImage = await downloadAndProcessImage(url); // always jpg
    } catch (error) {
        reply.status(400).send({ message: 'Hubo un error al obtener la imagen del NFT' });
        console.error('Error al descargar la imagen del NFT:', error);
        throw error;
    }

    const fileName = `${channel_user_id.toString()}_${Date.now()}.jpg`;
    let ipfsImageUrl = '';
    let icpImageUrl = '';

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

    try {
        console.info('guardando NFT en bdd');
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
                description: mensaje || '',
                geolocation: {
                    latitud: latitud || '',
                    longitud: longitud || '',
                },
            },
        });
    } catch (error) {
        console.error('Error al grabar NFT en bdd', error);
        throw error;
    }

    reply.status(200).send({ message: 'NFT minted.' });
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
    try {
        const { channel_user_id, id } = request.body;

        let address_of_user = await getWalletByPhoneNumber(channel_user_id);

        if (!address_of_user) {
            console.log('La wallet del usuario no existe. Creando...');
            address_of_user = await executeWalletCreation(channel_user_id);

            // Issue demo tokens to the user. This will be later removed in mainnet
            issueTokensCore(address_of_user);
        }

        const nfts: INFT[] = await NFTModel.find({ id: parseInt(id, 10) });

        if (!nfts) {
            reply.status(400).send({ message: 'El NFT no existe.' });
            return false;
        }

        let data;
        try {
            const nfImageURL = new URL(nfts[0].metadata.image_url.gcp ?? defaultNftImage);
            data = await mint_eth_nft(address_of_user, nfImageURL);
        } catch (error) {
            console.error('Error al mintear NFT:', error);
            throw error;
        }

        const defaultMetadata: INFTMetadata = {
            image_url: {
                gcp: '',
                icp: '',
                ipfs: '',
            },
            description: '',
            geolocation: {
                latitud: '',
                longitud: '',
            },
        };

        await NFTModel.create({
            id,
            channel_user_id,
            copy_of: id,
            original: false,
            timestamp: new Date(),
            wallet: address_of_user,
            trxId: data.transactionHash,
            metadata: nfts[0].metadata ? nfts[0].metadata : defaultMetadata,
        });

        sendMintNotification(channel_user_id, id);
        reply.status(200).send({ message: 'Certificado NFT generado.' });
        return true;
    } catch (error) {
        console.error('Error en mintExistingNFT', error.message);
        throw error;
    }
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
        console.log('buscando last_nft para channel_user_id', channel_user_id);
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
