import { FastifyRequest, FastifyReply } from "fastify";
import NFTModel, { getLastId } from "../models/nft";
import { ethers } from "ethers";
import { getWalletByPhoneNumber } from "../models/user";
import { SCROLL_CONFIG } from "../constants/networks";
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
            gasLimit: 100000
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
        const nft = await NFTModel.find({id}).exec();
        console.log(nft);
        if (nft[0]) {
            // Si el NFT se encuentra, responder con los datos del NFT
            reply.send(nft[0]);
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