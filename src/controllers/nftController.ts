import { FastifyRequest, FastifyReply } from "fastify";
import NFTModel, { getLastId } from "../models/nft";
import { ethers } from "ethers";
import { getWalletByPhoneNumber } from "../models/user";
import { SCROLL_CONFIG } from "../constants/networks";
import { sendMintNotification } from "./replyController";
//import {}

const NFT_ADDRESS = SCROLL_CONFIG.CHATTER_NFT;

const mint_eth_nft = async (
    recipientAddress: string,
    tokenURI: number
) => {
    // Configuración del proveedor y del firmante
    const provider = new ethers.providers.JsonRpcProvider("https://arbitrum-sepolia.blockpi.network/v1/rpc/public"); // ARB Sepolia
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

    // Instancia del contrato NFT
    const nftContract = new ethers.Contract(
        NFT_ADDRESS,
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
    const { channel_user_id, url, mensaje} = request.body;
    const address_of_user = await getWalletByPhoneNumber(channel_user_id);
    if (!address_of_user) {
        return reply.status(400).send({message: "La wallet del usuario no existe."})
    }

    reply.status(200).send({message: "El certificado en NFT está siendo generado..."});

    const new_id = await getLastId() + 1;
    console.log(new_id, address_of_user);
    let data;
    try {
        data = await mint_eth_nft(address_of_user, new_id);
    } catch {
        return reply.status(400).send({message: "Hubo un error al mintear el NFT."})
    }

    // Crear un nuevo documento en la colección 'nft'
    NFTModel.create({
        id: new_id,
        channel_user_id: channel_user_id,
        trxId: data.transactionHash,
        metadata: {
            image_url: url,
            description: mensaje
        }
    });

    sendMintNotification(channel_user_id, new_id);
    
    return;
}

export const getNFT = async (
    request: FastifyRequest<{
        Params: {
            id: Number;
        };
    }>,
    reply: FastifyReply
) => {
    try {
        const { id } = request.params;

        // Buscar el NFT por el campo 'id'
        const nft = (await NFTModel.find({id}))?.[0];
        console.log(nft);
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

export const getPhoneNFTs = async (phone_number: string) => {
    try {
        // Buscar todos los NFTs del usuario
        const nfts = await NFTModel.find({channel_user_id: phone_number});

        // Responder con la cantidad de NFTs y la lista de NFTs
        return {
            count: nfts.length,
            nfts: nfts.map(nft => ({
                description: nft.metadata.description,
                url: `https://testnets.opensea.io/assets/arbitrum-sepolia/${SCROLL_CONFIG.CHATTER_NFT}/${nft.id}`,
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
    reply.status(200).send(result);

    return result;
};