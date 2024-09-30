import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest } from 'fastify';

import { defaultNftImage } from '../constants/contracts';
import NFTModel, { INFT, INFTMetadata } from '../models/nft';
import { getWalletByPhoneNumber } from '../models/user';
import { getNetworkConfig } from '../services/networkService';
import { downloadAndProcessImage, uploadToICP, uploadToIpfs } from '../utils/uploadServices';
import { executeWalletCreation } from './newWalletController';
import { sendMintNotification } from './replyController';
import { issueTokensCore } from './tokenController';
import { isValidUrl } from '../utils/paramsUtils';

export interface NFTInfo {
    description: string;
    url: string;
}

/**
 * Mints an NFT on the Ethereum network.
 * @param {string} recipientAddress - The address to receive the minted NFT.
 * @param {string} name - The name of the NFT.
 * @param {string} description - The description of the NFT.
 * @param {string} image - The URL of the image associated with the NFT.
 * @returns {Promise<{ receipt: ethers.ContractReceipt, tokenId: ethers.BigNumber }>} An object containing the transaction receipt and the minted token ID.
 * @throws {Error} If minting fails.
 */
const mint_eth_nft = async (
    recipientAddress: string,
    name: string,
    description: string,
    image: string,
): Promise<{ receipt: ethers.ContractReceipt; tokenId: ethers.BigNumber }> => {
    try {
        // Obtener la configuración de la red (por ejemplo, arbitrum sepolia)
        const networkConfig = await getNetworkConfig(421614);
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);

        // Configurar el signer utilizando la clave privada del backend
        const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

        // Crear una instancia del contrato usando ethers.js
        const nftContract = new ethers.Contract(
            networkConfig.chatterNFTAddress,
            [
                'function safeMint(address to, string memory image) public returns (uint256)',
                'event Minted(address indexed to, uint256 indexed tokenId)',
            ],
            backendSigner,
        );

        console.log(
            'nft contract: ',
            nftContract.address,
            networkConfig.chatterNFTAddress,
            networkConfig.rpc,
            backendSigner.address,
        );

        console.log('Safe minting', recipientAddress, image);

        const tx = await nftContract.safeMint(recipientAddress, image, {
            gasLimit: 3000000,
        });

        console.log('Transaction sent: ', tx.hash);

        // Esperar a que la transacción se confirme
        const receipt = await tx.wait();
        console.log('Transaction confirmed: ', receipt.transactionHash);

        // Filtrar el evento Minted para obtener el tokenId
        const event = receipt.events?.find((e: { event: string; }) => e.event === 'Minted');

        if (!event) {
            throw new Error('Minted event not found in transaction receipt');
        }

        const tokenId = event.args?.tokenId;
        console.log('Token ID minted: ', tokenId.toString());

        return { receipt, tokenId };
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

    if (!isValidUrl(url)) {
        return reply.status(400).send({ message: 'La URL proporcionada no es válida.' });
    }

    const address_of_user = await getWalletByPhoneNumber(channel_user_id);
    if (!address_of_user) {
        return reply.status(400).send({ message: 'La wallet del usuario no existe.' });
    }

    try {
        // no await by this method
        processNftMint(address_of_user, channel_user_id, url, mensaje, latitud, longitud);
        return await reply.status(200).send({ message: 'El certificado se está procesando.' });
    } catch (error) {
        console.error('Error al enviar notificación de minteo de NFT', (error as Error).message);
        return reply.status(500).send({ message: 'Error al enviar notificación de minteo.' });
    }
};

const processNftMint = async (
    address_of_user: string,
    channel_user_id: string,
    url: string,
    mensaje: string,
    latitud: string,
    longitud: string,
) => {
    let data;
    try {
        const nfImageURL = new URL(url ?? defaultNftImage);
        data = await mint_eth_nft(
            address_of_user!,
            'chatterpay-nft',
            mensaje || '',
            nfImageURL.toString(),
        );
    } catch (error) {
        console.error('Error al mintear NFT:', error);
        return;
    }

    // OPTIMISTIC RESPONSE: respond quickly to the user and process the rest of the flow asynchronously.
    const nftMintedId = data.tokenId.toNumber();
    try {
        await sendMintNotification(channel_user_id, nftMintedId);
    } catch (error) {
        console.error('Error al enviar notificación de minteo de NFT', (error as Error).message);
        // No se lanza error aquí para continuar con el proceso
    }

    let processedImage;
    try {
        console.info('Obteniendo imagen de NFT');
        processedImage = await downloadAndProcessImage(url); // always jpg
    } catch (error) {
        console.error('Error al descargar la imagen del NFT:', (error as Error).message);
        return;
    }

    const fileName = `${channel_user_id.toString()}_${Date.now()}.jpg`;
    let ipfsImageUrl = '';
    let icpImageUrl = '';

    try {
        ipfsImageUrl = await uploadToIpfs(processedImage, fileName);
    } catch (error) {
        console.error('Error al subir la imagen a IPFS', (error as Error).message);
        // No se lanza error aquí para continuar con el proceso
    }

    try {
        icpImageUrl = await uploadToICP(processedImage, fileName);
    } catch (error) {
        console.error('Error al subir la imagen a ICP', (error as Error).message);
        // No se lanza error aquí para continuar con el proceso
    }

    try {
        console.info('Guardando NFT en bdd');
        await NFTModel.create({
            id: nftMintedId,
            channel_user_id,
            wallet: address_of_user,
            trxId: data.receipt.transactionHash,
            copy_of: null,
            original: true,
            timestamp: new Date(),
            metadata: {
                image_url: {
                    gcp: url || '',
                    icp: icpImageUrl || '',
                    ipfs: ipfsImageUrl || '',
                },
                description: mensaje || '',
                geolocation: {
                    latitud: latitud || '',
                    longitud: longitud || '',
                },
            },
        });
    } catch (error) {
        console.error('Error al grabar NFT en bdd', (error as Error).message);
    }
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
        }

        const nfts: INFT[] = await NFTModel.find({ id: parseInt(id, 10) });
        const nft = nfts[0];

        if (!nfts) {
            reply.status(400).send({ message: 'El NFT no existe.' });
            return false;
        }

        let data;
        try {
            const nfImageURL = new URL(nft.metadata.image_url.gcp ?? defaultNftImage);
            data = await mint_eth_nft(
                address_of_user,
                'chatterpay-nft-copy',
                `copia de nft ${nft.id}`,
                nfImageURL.toString(),
            );
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
            id: data.tokenId,
            channel_user_id,
            copy_of: id,
            original: false,
            timestamp: new Date(),
            wallet: address_of_user,
            trxId: data.receipt.transactionHash,
            metadata: nft.metadata ? nft.metadata : defaultMetadata,
        });

        sendMintNotification(channel_user_id, parseInt(id, 10));
        reply.status(200).send({ message: 'Certificado NFT generado.' });
        return true;
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error en mintExistingNFT', error.message);
        } else {
            console.error('Error en mintExistingNFT', error);
        }
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
            nfts: nfts.map((nft: INFT) => ({
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
