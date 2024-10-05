import { ethers } from 'ethers';
import { FastifyReply, FastifyRequest } from 'fastify';

import { defaultNftImage, networkChainIds } from '../constants/contracts';
import { SIGNING_KEY } from '../constants/environment';
import NFTModel, { INFT, INFTMetadata } from '../models/nft';
import { getWalletByPhoneNumber } from '../models/user';
import { getNetworkConfig } from '../services/networkService';
import { getDynamicGas } from '../utils/dynamicGas';
import { isValidUrl } from '../utils/paramsUtils';
import { downloadAndProcessImage, uploadToICP, uploadToIpfs } from '../utils/uploadServices';
import { executeWalletCreation } from './newWalletController';
import { sendMintNotification } from './replyController';

export interface NFTInfo {
    description: string;
    url: string;
}

interface NFTData {
    receipt: ethers.ContractReceipt;
    tokenId: ethers.BigNumber;
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
): Promise<NFTData> => {
    try {
        // Obtener la configuración de la red (por ejemplo, arbitrum sepolia)
        const networkConfig = await getNetworkConfig(networkChainIds.arbitrumSepolia);
        const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);

        // Configurar el signer utilizando la clave privada del backend
        const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);

        // Crear una instancia del contrato usando ethers.js
        const nftContract = new ethers.Contract(
            networkConfig.contracts.chatterNFTAddress,
            [
                'function safeMint(address to, string memory image) public returns (uint256)',
                'event Minted(address indexed to, uint256 indexed tokenId)',
            ],
            backendSigner,
        );

        console.log(
            'nft contract: ',
            networkConfig.contracts.chatterNFTAddress,
            networkConfig.rpc,
            backendSigner.address,
        );

        console.log('Safe minting', recipientAddress, image);

        const tx = await nftContract.safeMint(recipientAddress, image, {
            gasLimit: await getDynamicGas(nftContract, 'safeMint', [recipientAddress, image]),
        });

        console.log('Transaction sent: ', tx.hash);

        // Esperar a que la transacción se confirme
        const receipt = await tx.wait();
        console.log('Transaction confirmed: ', receipt.transactionHash);

        // Filtrar el evento Minted para obtener el tokenId
        const event = receipt.events?.find((e: { event: string }) => e.event === 'Minted');

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
): Promise<void> => {
    const { channel_user_id, url, mensaje, latitud, longitud } = request.body;

    if (!isValidUrl(url)) {
        return reply.status(400).send({ message: 'La URL proporcionada no es válida.' });
    }

    const address_of_user = await getWalletByPhoneNumber(channel_user_id);
    if (!address_of_user) {
        return reply.status(400).send({ message: 'La wallet del usuario no existe.' });
    }

    reply.status(200).send({ message: `El certificado se está generando` });

    // Continuar el procesamiento en segundo plano sin await
    processNftMint(address_of_user, channel_user_id, url, mensaje)
        .then((nftData) => {
            persistNftInBdd(
                address_of_user,
                channel_user_id,
                url,
                mensaje,
                latitud,
                longitud,
                nftData,
            );
        })
        .catch((error) => {
            console.error('Error al procesar el minteo del NFT:', error.message);
        });

    console.log('NFT mint end.');

    // Retorna void explícitamente
    return Promise.resolve();
};

const processNftMint = async (
    address_of_user: string,
    channel_user_id: string,
    url: string,
    mensaje: string,
): Promise<NFTData> => {
    let data: NFTData;

    try {
        const nfImageURL = new URL(url ?? defaultNftImage);
        data = await mint_eth_nft(
            address_of_user,
            'chatterpay-nft',
            mensaje || '',
            nfImageURL.toString(),
        );
    } catch (error) {
        console.error('Error al mintear NFT:', error);
        throw error;
    }

    const nftMintedId = data.tokenId.toString();
    try {
        await sendMintNotification(channel_user_id, nftMintedId);
    } catch (error) {
        console.error('Error al enviar notificación de minteo de NFT', (error as Error).message);
        // No se lanza error aquí para continuar con el proceso
    }

    return data;
};

const persistNftInBdd = async (
    address_of_user: string,
    channel_user_id: string,
    url: string,
    mensaje: string,
    latitud: string,
    longitud: string,
    nftData: NFTData,
) => {
    let processedImage;
    try {
        console.info('Obteniendo imagen de NFT');
        processedImage = await downloadAndProcessImage(url); // always jpg
    } catch (error) {
        console.error('Error al descargar la imagen del NFT:', (error as Error).message);
        return;
    }

    // Guardar los detalles iniciales del NFT en la base de datos.
    try {
        console.info('Guardando NFT inicial en bdd');
        await NFTModel.create({
            id: nftData.tokenId.toString(),
            channel_user_id,
            wallet: address_of_user,
            trxId: nftData.receipt.transactionHash,
            timestamp: new Date(),
            original: true,
            total_of_this: 1,
            copy_of: null,
            copy_of_original: null,
            copy_order: 1,
            copy_order_original: 1,
            metadata: {
                image_url: {
                    gcp: url || '',
                    icp: '',
                    ipfs: '',
                },
                description: mensaje || '',
                geolocation: {
                    latitud: latitud || '',
                    longitud: longitud || '',
                },
            },
        });
    } catch (error) {
        console.error('Error al grabar NFT inicial en bdd', (error as Error).message);
        return; // Si falla la creación inicial, no tiene sentido continuar
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

    // Actualizar las URLs de IPFS e ICP en la base de datos
    try {
        console.info('Actualizando URLs de IPFS e ICP en bdd');
        await NFTModel.updateOne(
            { id: nftData.tokenId.toString() },
            {
                $set: {
                    'metadata.image_url.icp': icpImageUrl || '',
                    'metadata.image_url.ipfs': ipfsImageUrl || '',
                },
            },
        );
    } catch (error) {
        console.error('Error al actualizar NFT en bdd', (error as Error).message);
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
): Promise<void> => {
    try {
        const { channel_user_id, id } = request.body;

        // Verify that the NFT to copy exists
        const nfts: INFT[] = await NFTModel.find({ id });
        if (!nfts || nfts.length === 0) {
            return await reply.status(400).send({ message: 'El NFT no existe.' });
        }

        // Verify that the user exists
        let address_of_user = await getWalletByPhoneNumber(channel_user_id);
        if (!address_of_user) {
            console.log('La wallet del usuario no existe. Creando...');
            address_of_user = await executeWalletCreation(channel_user_id);
            console.log('Wallet creada.');
        }

        // optimistic response
        reply.status(200).send({ message: `El certificado se está generando` });

        // mint
        const nftCopyOf = nfts[0];
        let nftData: NFTData;
        try {
            const nfImageURL = new URL(nftCopyOf.metadata.image_url.gcp ?? defaultNftImage);
            nftData = await mint_eth_nft(
                address_of_user,
                'chatterpay-nft-copy',
                `nft-copy`,
                nfImageURL.toString(),
            );
        } catch (error) {
            console.error('Error al mintear NFT:', error);
            return await Promise.resolve();
        }
        await sendMintNotification(channel_user_id, nftData.tokenId.toString());

        // search by NFT original
        let copy_of_original = nftCopyOf.id;
        let copy_order_original = nftCopyOf.total_of_this + 1;

        if (!nftCopyOf.original) {
            // Se esta copiando de una copia. Entonces, se busca el original
            console.log('Searching by nft original.');
            const nftOriginal: INFT | null = await NFTModel.findOne({
                id: nftCopyOf.copy_of_original,
            });
            if (nftOriginal) {
                copy_of_original = nftOriginal.id;
                copy_order_original = nftOriginal.total_of_this + 1;

                // update total_of_this in the ORIGINAL NFT
                console.log('Updating original NFT total_of_this field.');
                await NFTModel.updateOne({ _id: nftOriginal._id }, { $inc: { total_of_this: 1 } });
            }
        }

        console.log('Saving NFT copy in database.');
        await NFTModel.create({
            id: nftData.tokenId,
            channel_user_id,
            timestamp: new Date(),
            original: false,
            total_of_this: 1,
            copy_of: nftCopyOf.id,
            copy_order: nftCopyOf.total_of_this + 1,
            copy_of_original,
            copy_order_original,
            wallet: address_of_user,
            trxId: nftData.receipt.transactionHash,
            metadata: nftCopyOf.metadata ? nftCopyOf.metadata : defaultMetadata,
        });

        // update total_of_this in the copied NFT
        console.log('Updating copied NFT total_of_this field.');
        await NFTModel.updateOne({ _id: nftCopyOf._id }, { $inc: { total_of_this: 1 } });

        console.log('NFT copy end.');
    } catch (error) {
        console.error('Error en mintExistingNFT', (error as Error).message);
    }

    // Retorna void explícitamente
    return Promise.resolve();
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
        const networkConfig = await getNetworkConfig(networkChainIds.arbitrumSepolia);
        const nfts = await NFTModel.find({ channel_user_id: phone_number });

        return {
            count: nfts.length,
            nfts: nfts.map((nft: INFT) => ({
                description: nft.metadata.description,
                url: `https://testnets.opensea.io/assets/arbitrum-sepolia/${networkConfig.contracts.chatterNFTAddress}/${nft.id}`,
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

/**
 * Retrieves the NFT information by its token ID.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<void>} The NFT information.
 */
export const getNftList = async (
    request: FastifyRequest<{
        Params: {
            tokenId: number;
        };
    }>,
    reply: FastifyReply,
): Promise<void> => {
    const { tokenId } = request.params;
    try {
        const nfts = await NFTModel.find({ id: tokenId });

        if (nfts.length === 0) {
            return await reply.status(400).send({ message: 'NFT not found' });
        }

        const nft = nfts[0];
        if (nft.original) {
            return await reply.status(200).send({
                original: nft,
                copies: await NFTModel.find({ copy_of: tokenId.toString() }),
            });
        }

        const originalNft = (await NFTModel.find({ id: nft.copy_of }))?.[0];
        return await reply.status(200).send({
            original: originalNft,
            copy: nft,
        });
    } catch (error) {
        console.error('Error al obtener el NFT:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};

/**
 * Retrieves the NFT metadata required by the smart contract to be displayed on OpenSea.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<void>} The NFT metadata required by openSea.
 */
export const getNftMetadataRequiredByOpenSea = async (
    request: FastifyRequest<{
        Params: {
            tokenId: number;
        };
    }>,
    reply: FastifyReply,
): Promise<void> => {
    const { tokenId } = request.params;
    try {
        const nfts: INFT[] = await NFTModel.find({ id: tokenId });

        if (nfts.length === 0) {
            return await reply.status(400).send({ message: 'NFT not found' });
        }

        const nft: INFT = nfts[0];

        return await reply.status(200).send({
            id: nft.id,
            name: 'Chatterpay',
            description: nft.metadata.description,
            image: nft.metadata.image_url.gcp ?? defaultNftImage,
            attributes: {
                id: nft.id,
                original: nft.original,
                total_of_this: nft.total_of_this,
                copy_of: nft.copy_of ?? '',
                copy_order: nft.copy_order,
                copy_of_original: nft.copy_order_original,
                copy_order_original: nft.copy_order_original,
                creation_date: nft.timestamp,
                geolocation: nft.metadata.geolocation,
                image_urls: nft.metadata.image_url,
            },
        });
    } catch (error) {
        console.error('Error al obtener el NFT:', error);
        return reply.status(500).send({ message: 'Internal Server Error' });
    }
};
