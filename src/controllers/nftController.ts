import { ethers } from "ethers";
import { FastifyReply, FastifyRequest } from "fastify";

import NFTModel, { getLastId } from "../models/nft";
import { getWalletByPhoneNumber } from "../models/user";
import { sendMintNotification } from "./replyController";
import { executeWalletCreation } from "./newWalletController";
import { getNetworkConfig } from "../services/networkService";

export interface NFTInfo {
    description: string;
    url: string;
}

const mint_eth_nft = async (
    recipientAddress: string,
    tokenURI: number
) => {
    const networkConfig = await getNetworkConfig(421614);
    // Configuración del proveedor y del firmante
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

    // Instancia del contrato NFT
    const nftContract = new ethers.Contract(
        networkConfig.chatterNFTAddress,
        [
            "function safeMint(address to, string memory uri) public returns (uint256)"
        ],
        backendSigner
    );

    try {
        // Llamada a la función mint del contrato
        const tx = await nftContract.safeMint(recipientAddress, tokenURI, {
            gasLimit: 500000
        });


        console.log("Transaction sent: ", tx.hash);

        // Esperar la confirmación de la transacción
        const receipt = await tx.wait();
        console.log("Transaction confirmed: ", receipt.transactionHash);

        return receipt;
    } catch (error) {
        console.error("Error minting NFT: ", error);
        throw new Error("Minting failed");
    }
};

export const mintNFT = async (
    request: FastifyRequest<{
        Body: {
            channel_user_id: string;
            url: string,
            mensaje: string
        };
    }>,
    reply: FastifyReply
) => {
    const { channel_user_id, url, mensaje } = request.body;
    const address_of_user = await getWalletByPhoneNumber(channel_user_id);
    if (!address_of_user) {
        return reply.status(400).send({ message: "La wallet del usuario no existe." })
    }

    reply.status(200).send({ message: "El certificado en NFT está siendo generado..." });

    const new_id = await getLastId() + 1;

    let data;
    try {
        data = await mint_eth_nft(address_of_user, new_id);
    } catch {
        return reply.status(400).send({ message: "Hubo un error al mintear el NFT." })
    }

    // Crear un nuevo documento en la colección 'nfts'
    NFTModel.create({
        id: new_id,
        channel_user_id,
        wallet: address_of_user,
        trxId: data.transactionHash,
        metadata: {
            image_url: url,
            description: mensaje
        }
    });

    sendMintNotification(channel_user_id, new_id);

    return true;
}

export const mintExistingNFT = async (
    request: FastifyRequest<{
        Body: {
            channel_user_id: string;
            id: string,
        };
    }>,
    reply: FastifyReply
) => {
    const { channel_user_id, id } = request.body;

    let address_of_user = await getWalletByPhoneNumber(channel_user_id);

    if (!address_of_user) {
        console.log("La wallet del usuario no existe. Creando...");
        address_of_user = await executeWalletCreation(channel_user_id);
    }

    reply.status(200).send({ message: "El certificado en NFT está siendo generado..." });

    const nft = await NFTModel.find({ id: parseInt(id, 10) });

    if (!nft) {
        return reply.status(400).send({ message: "El NFT no existe." })
    }
    const new_id = await getLastId() + 1;

    let data;
    try {
        data = await mint_eth_nft(address_of_user, new_id);
    } catch {
        return reply.status(400).send({ message: "Hubo un error al mintear el NFT." })
    }

    // Crear un nuevo documento en la colección 'nfts'
    NFTModel.create({
        id: new_id,
        channel_user_id,
        wallet: address_of_user,
        trxId: data.transactionHash,
        metadata: nft?.[0]?.metadata ? nft?.[0]?.metadata : { image_url: "", description: "" }
    });

    sendMintNotification(channel_user_id, new_id);

    return true;
}

export const getNFT = async (
    request: FastifyRequest<{
        Params: {
            id: number;
        };
    }>,
    reply: FastifyReply
) => {
    try {
        const { id } = request.params;

        // Buscar el NFT por el campo 'id'
        const nft = (await NFTModel.find({ id }))?.[0];

        if (nft) {
            // Si el NFT se encuentra, responder con los datos del NFT
            reply.send({
                image: nft.metadata.image_url,
                description: nft.metadata.description,
            });
        } else {
            // Si no se encuentra el NFT, responder con un error 404
            reply.status(404).send({ message: 'NFT not found' });
        }

    } catch (error) {
        // Manejo de errores
        console.error('Error al obtener el NFT:', error);
        reply.status(500).send({ message: 'Internal Server Error' });
    }
};

export const getLastNFT = async (
    request: FastifyRequest<{
        Querystring: {
            channel_user_id: string;
        };
    }>,
    reply: FastifyReply
) => {
    try {
        const { channel_user_id } = request.query;

        // Buscar el NFT por el campo 'id'
        const nft = (await NFTModel.find({ channel_user_id })).sort((a, b) => b.id - a.id)?.[0];

        if (nft) {
            reply.redirect(`https://api.whatsapp.com/send/?phone=5491164629653&text=Me%20gustar%C3%ADa%20mintear%20el%20NFT%20${nft.id}`);
        } else {
            // Si no se encuentra el NFT, responder con un error 404
            reply.status(404).send({ message: 'NFT not found' });
        }
    } catch (error) {
        // Manejo de errores
        console.error('Error al obtener el NFT:', error);
        reply.status(500).send({ message: 'Internal Server Error' });
    }
}

export const getPhoneNFTs = async (phone_number: string) => {
    try {
        const networkConfig = await getNetworkConfig(421614);
        // Buscar todos los NFTs del usuario
        const nfts = await NFTModel.find({ channel_user_id: phone_number });

        // Responder con la cantidad de NFTs y la lista de NFTs
        return {
            count: nfts.length,
            nfts: nfts.map(nft => ({
                description: nft.metadata.description,
                url: `https://testnets.opensea.io/assets/arbitrum-sepolia/${networkConfig.chatterNFTAddress}/${nft.id}`,
            }))
        };
    } catch (error) {
        // Manejo de errores
        console.error('Error al obtener los NFTs:', error);
        throw new Error('Internal Server Error');
    }
}

export const getAllNFTs = async (request: FastifyRequest<{ Querystring: { channel_user_id: string } }>, reply: FastifyReply): Promise<{
    count: number;
    nfts: {
        description: string;
        url: string;
    }[];
}> => {
    const { channel_user_id: phone_number } = request.query;

    const result = await getPhoneNFTs(phone_number);

    return reply.status(200).send(result);
};