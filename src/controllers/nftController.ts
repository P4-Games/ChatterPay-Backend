import { ethers } from "ethers";
import { FastifyReply, FastifyRequest } from "fastify";

import NFTModel, { getLastId } from "../models/nft";
import { getWalletByPhoneNumber } from "../models/user";
import { sendMintNotification } from "./replyController";
import { getNetworkConfig } from "../services/networkService";

interface MintNFTBody {
    channel_user_id: string;
    url: string;
    mensaje: string;
}

interface NFTMetadata {
    image: string;
    description: string;
}

export interface NFTInfo {
    description: string;
    url: string;
}

interface NFTResponse {
    count: number;
    nfts: NFTInfo[];
}

/**
 * Mints an NFT on the blockchain.
 * @param recipientAddress The address to mint the NFT to.
 * @param tokenURI The token URI for the NFT.
 * @returns The transaction receipt.
 */
const mintEthNFT = async (
    recipientAddress: string,
    tokenURI: number
): Promise<ethers.ContractReceipt> => {
    const networkConfig = await getNetworkConfig(421614);
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const backendSigner = new ethers.Wallet(process.env.SIGNING_KEY!, provider);

    const nftContract = new ethers.Contract(
        networkConfig.chatterNFTAddress,
        ["function safeMint(address to, string memory uri) public returns (uint256)"],
        backendSigner
    );

    try {
        const tx = await nftContract.safeMint(recipientAddress, tokenURI.toString(), {
            gasLimit: 500000
        });

        console.log("Transaction sent: ", tx.hash);
        const receipt = await tx.wait();
        console.log("Transaction confirmed: ", receipt.transactionHash);
        return receipt;
    } catch (error) {
        console.error("Error minting NFT: ", error);
        throw new Error("Minting failed");
    }
};


/**
 * Creates a new NFT document in the database.
 * @param id The NFT ID.
 * @param channelUserId The user's channel ID.
 * @param wallet The user's wallet address.
 * @param transactionHash The transaction hash.
 * @param url The image URL.
 * @param mensaje The NFT description.
 */
const createNFTDocument = async (
    id: number,
    channelUserId: string,
    wallet: string,
    transactionHash: string,
    url: string,
    mensaje: string
): Promise<void> => {
    await NFTModel.create({
        id,
        channel_user_id: channelUserId,
        wallet,
        trxId: transactionHash,
        metadata: {
            image_url: url,
            description: mensaje
        }
    });
};

/**
 * Handles the minting of a new NFT.
 */
export const mintNFT = async (
    request: FastifyRequest<{ Body: MintNFTBody }>,
    reply: FastifyReply
): Promise<void> => {
    const { channel_user_id, url, mensaje } = request.body;
    const address_of_user = await getWalletByPhoneNumber(channel_user_id);

    if (!address_of_user) {
        reply.status(400).send({ message: "La wallet del usuario no existe." });
        return;
    }

    reply.status(200).send({ message: "El certificado en NFT está siendo generado..." });

    const new_id = await getLastId() + 1;

    try {
        const data = await mintEthNFT(address_of_user, new_id);
        await createNFTDocument(new_id, channel_user_id, address_of_user, data.transactionHash, url, mensaje);
        await sendMintNotification(channel_user_id, new_id);
    } catch (error) {
        console.error("Error in mintNFT:", error);
        reply.status(400).send({ message: "Hubo un error al mintear el NFT." });
    }
};

/**
 * Retrieves NFT metadata by ID.
 */
export const getNFT = async (
    request: FastifyRequest<{ Params: { id: number } }>,
    reply: FastifyReply
): Promise<void> => {
    try {
        const { id } = request.params;
        const nft = await NFTModel.findOne({ id });

        if (nft) {
            const metadata: NFTMetadata = {
                image: nft.metadata.image_url,
                description: nft.metadata.description,
            };
            reply.send(metadata);
        } else {
            reply.status(404).send({ message: 'NFT not found' });
        }
    } catch (error) {
        console.error('Error retrieving NFT:', error);
        reply.status(500).send({ message: 'Internal Server Error' });
    }
};

/**
 * Retrieves all NFTs for a given phone number.
 * @param phone_number The user's phone number.
 * @returns An object containing the count and list of NFTs.
 */
export const getPhoneNFTs = async (phone_number: string): Promise<NFTResponse> => {
    try {
        const nfts = await NFTModel.find({ channel_user_id: phone_number });
        const networkConfig = await getNetworkConfig(421614);
        return {
            count: nfts.length,
            nfts: nfts.map(nft => ({
                description: nft.metadata.description,
                url: `https://testnets.opensea.io/assets/arbitrum-sepolia/${networkConfig.chatterNFTAddress}/${nft.id}`,
            }))
        };
    } catch (error) {
        console.error('Error retrieving NFTs:', error);
        throw new Error('Internal Server Error');
    }
};

/**
 * Handles the retrieval of all NFTs for a user.
 */
export const getAllNFTs = async (
    request: FastifyRequest<{ Querystring: { channel_user_id: string } }>,
    reply: FastifyReply
): Promise<void> => {
    const { channel_user_id: phone_number } = request.query;

    try {
        const result = await getPhoneNFTs(phone_number);
        reply.status(200).send(result);
    } catch (error) {
        console.error('Error in getAllNFTs:', error);
        reply.status(500).send({ message: 'Internal Server Error' });
    }
};