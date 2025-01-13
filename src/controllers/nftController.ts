import { ethers } from 'ethers';
import NodeCache from 'node-cache';
import mongoose, { ObjectId } from 'mongoose';
import { FastifyReply, FastifyRequest } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { IUser, IUserWallet } from '../models/userModel';
import { getDynamicGas } from '../helpers/paymasterHelper';
import { ConcurrentOperationsEnum } from '../types/common';
import { getNetworkConfig } from '../services/networkService';
import NFTModel, { INFT, INFTMetadata } from '../models/nftModel';
import { sendMintNotification } from '../services/notificationService';
import { SIGNING_KEY, defaultNftImage, DEFAULT_CHAIN_ID } from '../config/constants';
import { isShortUrl, isValidUrl, isValidPhoneNumber } from '../helpers/validationHelper';
import { uploadToICP, uploadToIpfs, downloadAndProcessImage } from '../services/uploadService';
import {
  returnErrorResponse,
  returnSuccessResponse,
  returnErrorResponse500
} from '../helpers/requestHelper';
import {
  getUserWallet,
  openOperation,
  closeOperation,
  getOrCreateUser,
  getUserWalletByChainId,
  hasPhoneAnyOperationInProgress
} from '../services/userService';

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
    ipfs: ''
  },
  description: '',
  geolocation: {
    latitud: '',
    longitud: ''
  }
};

const cache = new NodeCache();

/**
 * Mints an NFT on the Ethereum network.
 * @param {string} recipientAddress - The address to receive the minted NFT.
 * @param {string} name - The name of the NFT.
 * @param {string} description - The description of the NFT.
 * @param {string} image - The URL of the image associated with the NFT.
 * @returns {Promise<{ receipt: ethers.ContractReceipt, tokenId: ethers.BigNumber }>} An object containing the transaction receipt and the minted token ID.
 * @throws {Error} If minting fails.
 */
const mintNftOriginal = async (
  recipientAddress: string,
  bddIdToUseAsUri: string
): Promise<NFTData> => {
  try {
    const networkConfig = await getNetworkConfig(DEFAULT_CHAIN_ID);
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
    const nftContract = new ethers.Contract(
      networkConfig.contracts.chatterNFTAddress,
      [
        'function mintOriginal(address to, string memory uri) public',
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
      ],
      backendSigner
    );

    Logger.log(
      'mintNftOriginal',
      recipientAddress,
      networkConfig.contracts.chatterNFTAddress,
      networkConfig.rpc,
      backendSigner.address
    );

    const gasLimit = await getDynamicGas(nftContract, 'mintOriginal', [
      recipientAddress,
      bddIdToUseAsUri
    ]);
    const tx = await nftContract.mintOriginal(recipientAddress, bddIdToUseAsUri, {
      gasLimit
    });

    Logger.log('mintNftOriginal', 'Transaction sent: ', tx.hash);

    // Esperar a que la transacción se confirme
    const receipt = await tx.wait();
    Logger.log('mintNftOriginal', 'Transaction confirmed: ', receipt.transactionHash);

    // Filtrar el evento Minted para obtener el tokenId
    const event = receipt.events?.find((e: { event: string }) => e.event === 'Transfer');

    if (!event) {
      throw new Error('Minted event not found in transaction receipt');
    }

    const tokenId = event.args?.tokenId;
    Logger.log('mintNftOriginal', 'Token ID minted: ', tokenId.toString());

    return { receipt, tokenId };
  } catch (error) {
    Logger.error('mintNftOriginal', error);
    throw new Error('Minting NFT Original failed');
  }
};

const mintNftCopy = async (
  recipientAddress: string,
  originalTOkenId: string,
  bddIdToUseAsUri: string
): Promise<NFTData> => {
  try {
    const networkConfig = await getNetworkConfig(DEFAULT_CHAIN_ID);
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const backendSigner = new ethers.Wallet(SIGNING_KEY!, provider);
    const nftContract = new ethers.Contract(
      networkConfig.contracts.chatterNFTAddress,
      [
        'function mintCopy(address to, uint256 originalTokenId, string memory uri) public',
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
      ],
      backendSigner
    );

    Logger.log(
      'mintNftCopy',
      recipientAddress,
      networkConfig.contracts.chatterNFTAddress,
      networkConfig.rpc,
      backendSigner.address
    );

    const gasLimit = await getDynamicGas(nftContract, 'mintCopy', [
      recipientAddress,
      parseInt(originalTOkenId, 10),
      bddIdToUseAsUri
    ]);
    const tx = await nftContract.mintCopy(
      recipientAddress,
      parseInt(originalTOkenId, 10),
      bddIdToUseAsUri,
      { gasLimit }
    );

    Logger.log('mintNftCopy', 'Transaction sent: ', tx.hash);

    // Esperar a que la transacción se confirme
    const receipt = await tx.wait();
    Logger.log('mintNftCopy', 'Transaction confirmed: ', receipt.transactionHash);

    // Filtrar el evento Minted para obtener el tokenId
    const event = receipt.events?.find((e: { event: string }) => e.event === 'Transfer');

    if (!event) {
      throw new Error('Minted event not found in transaction receipt');
    }

    const tokenId = event.args?.tokenId;
    Logger.log('mintNftCopy', 'NFT Copy ID minted: ', tokenId.toString());

    return { receipt, tokenId };
  } catch (error) {
    Logger.error('mintNftCopy', error);
    throw new Error('Minting NFT Copy failed');
  }
};

/**
 * Handles the minting of a new NFT.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<boolean>} True if minting was successful.
 */
export const generateNftOriginal = async (
  request: FastifyRequest<{
    Body: {
      channel_user_id: string;
      url: string;
      mensaje: string;
      latitud: string;
      longitud: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> => {
  if (!request.body) {
    return returnErrorResponse(reply, 400, 'You have to send a body with this request');
  }

  const { channel_user_id, url, mensaje, latitud, longitud } = request.body;

  if (!channel_user_id || !url) {
    return returnErrorResponse(
      reply,
      400,
      'Missing parameters in body. You have to send: channel_user_id, url, mensaje, latitud, longitud'
    );
  }

  if (!isValidPhoneNumber(channel_user_id)) {
    return returnErrorResponse(
      reply,
      400,
      `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
    );
  }

  if (!isValidUrl(url)) {
    Logger.warn('generateNftOriginal', 'The provided URL is not valid.');
    return returnErrorResponse(reply, 400, 'The provided URL is not valid.');
  }

  if (isShortUrl(url)) {
    Logger.warn('generateNftOriginal', 'Short Url not allowed');
    return returnErrorResponse(reply, 400, 'Short Url not allowed');
  }

  const userWallet: IUserWallet | null = await getUserWallet(channel_user_id, DEFAULT_CHAIN_ID);
  if (!userWallet) {
    Logger.warn('generateNftOriginal', 'Wallet User doesnt exists.');
    return returnErrorResponse(reply, 400, 'Wallet User doesnt exists.');
  }

  if (await hasPhoneAnyOperationInProgress(channel_user_id)) {
    const validationError = `Concurrent mint original NFT for wallet ${userWallet.wallet_proxy}, phone: ${channel_user_id}.`;
    Logger.log('generateNftOriginal', `generateNftOriginal: ${validationError}`);
    return returnErrorResponse(reply, 400, validationError);
  }
  await openOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);

  returnSuccessResponse(reply, 'The certificate is being generated');

  let processedImage;
  try {
    Logger.info('generateNftOriginal', 'Fetching NFT image');
    processedImage = await downloadAndProcessImage(url);
  } catch (error) {
    await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);
    Logger.error(
      'generateNftOriginal',
      'Error downloading the NFT image:',
      (error as Error).message
    );
    return Promise.resolve();
  }

  // Save the initial NFT details in the database.
  let mongoData;
  try {
    Logger.info('generateNftOriginal', 'Saving NFT Data into MongoDB');
    mongoData = await NFTModel.create({
      channel_user_id,
      wallet: userWallet.wallet_proxy,
      id: '0', // tbc later nftData.tokenId.toString(),
      trxId: '0', // tbc later nftData.receipt.transactionHash,
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
          ipfs: ''
        },
        description: mensaje || '',
        geolocation: {
          latitud: latitud || '',
          longitud: longitud || ''
        }
      }
    });
  } catch (error) {
    await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);
    Logger.error('generateNftOriginal', 'Error saving NFT data into DB.', (error as Error).message);
    return Promise.resolve(); // If the initial creation fails, it makes no sense to continue.
  }

  let nftData: NFTData;
  try {
    nftData = await mintNftOriginal(
      userWallet.wallet_proxy,
      (mongoData._id as ObjectId).toString()
    );
  } catch (error) {
    await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);
    Logger.error('generateNftOriginal', 'Error minting NFT', error);
    return Promise.resolve();
  }
  const nftMintedId = nftData.tokenId.toString();

  try {
    await sendMintNotification(userWallet.wallet_proxy, channel_user_id, nftMintedId);
  } catch (error) {
    Logger.warn(
      'generateNftOriginal',
      'Error sending NFT minting notification:',
      (error as Error).message
    );
    // No error is thrown here to continue with the process
  }

  // Update in bdd trxId and tokenId
  try {
    Logger.info('generateNftOriginal', 'Updating tokenId and trxId in the database');
    await NFTModel.updateOne(
      { _id: mongoData._id },
      {
        $set: {
          trxId: nftData.receipt.transactionHash || '',
          id: nftData.tokenId.toString()
        }
      }
    );
  } catch (error) {
    Logger.error('generateNftOriginal', 'Error updating NFT in bdd', (error as Error).message);
  }

  const fileName = `${channel_user_id.toString()}_${Date.now()}.jpg`;
  let ipfsImageUrl = '';
  let icpImageUrl = '';

  try {
    ipfsImageUrl = await uploadToIpfs(processedImage, fileName);
  } catch (error) {
    Logger.warn(
      'generateNftOriginal',
      'Error uploading the image to IPFS:',
      (error as Error).message
    );
    // No error is thrown here to continue with the process
  }

  try {
    icpImageUrl = await uploadToICP(processedImage, fileName);
  } catch (error) {
    Logger.warn(
      'generateNftOriginal',
      'Error uploading the image to ICP:',
      (error as Error).message
    );
    // No error is thrown here to continue with the process
  }

  // Update IPFS & ICP urls in bdd
  try {
    Logger.info('generateNftOriginal', 'Updating IPFS and ICP URLs in the database');
    await NFTModel.updateOne(
      { _id: mongoData._id },
      {
        $set: {
          'metadata.image_url.icp': icpImageUrl || '',
          'metadata.image_url.ipfs': ipfsImageUrl || ''
        }
      }
    );
  } catch (error) {
    Logger.error('generateNftOriginal', 'Error updating NFT in bdd', (error as Error).message);
  }
  await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);
  Logger.log('generateNftOriginal', 'NFT minting end.');
  return Promise.resolve();
};

/**
 * Mints an existing NFT for a user.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<boolean>} True if minting was successful.
 */
export const generateNftCopy = async (
  request: FastifyRequest<{
    Body: {
      channel_user_id: string;
      id: string;
    };
  }>,
  reply: FastifyReply
): Promise<void> => {
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { channel_user_id, id } = request.body;

    if (!channel_user_id) {
      return await returnErrorResponse(
        reply,
        400,
        'Missing parameters in body. You have to send: channel_user_id'
      );
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    // Verify that the NFT to copy exists
    const nfts: INFT[] = await NFTModel.find({ id });
    if (!nfts || nfts.length === 0) {
      return await returnErrorResponse(reply, 400, "The NFT doesn't exist.");
    }
    const nftCopyOf = nfts[0];

    if (await hasPhoneAnyOperationInProgress(channel_user_id)) {
      const validationError = `Concurrent mint copy NFT for phone: ${channel_user_id}.`;
      Logger.log('generateNftCopy', `${validationError}`);
      return await returnErrorResponse(reply, 400, validationError);
    }
    await openOperation(channel_user_id, ConcurrentOperationsEnum.MintNftCopy);

    // optimistic response
    Logger.log('generateNftCopy', 'sending notification: the certificate is being generated');
    returnSuccessResponse(reply, 'The certificate is being generated');

    // search by NFT original
    let copy_of_original = nftCopyOf.id;
    let copy_order_original = nftCopyOf.total_of_this + 1;

    if (!nftCopyOf.original) {
      // If it is being copied from a copy, then the original is sought.
      Logger.log('generateNftCopy', 'Searching by nft original.');
      const nftOriginal: INFT | null = await NFTModel.findOne({
        id: nftCopyOf.copy_of_original
      });
      if (nftOriginal) {
        copy_of_original = nftOriginal.id;
        copy_order_original = nftOriginal.total_of_this + 1;

        // update total_of_this in the ORIGINAL NFT
        Logger.log('generateNftCopy', 'Updating original NFT total_of_this field.');
        await NFTModel.updateOne({ _id: nftOriginal._id }, { $inc: { total_of_this: 1 } });
      }
    }

    Logger.log('generateNftCopy', 'Saving NFT copy in database');
    const fastify = request.server;
    const chatterpayImplementation: string = fastify.networkConfig.contracts.chatterPayAddress;
    const user: IUser = await getOrCreateUser(channel_user_id, chatterpayImplementation);
    const userWallet: IUserWallet | null = getUserWalletByChainId(user.wallets, DEFAULT_CHAIN_ID);
    if (!userWallet) {
      Logger.warn('generateNftCopy', 'Wallet User doesnt exists.');
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNftCopy);
      return await returnErrorResponse(reply, 400, 'Wallet User doesnt exists.');
    }

    const mongoData = await NFTModel.create({
      id: '0', // update later nftData.tokenId,
      trxId: '0', // update later nftData.receipt.transactionHash,
      channel_user_id,
      timestamp: new Date(),
      original: false,
      total_of_this: 1,
      copy_of: nftCopyOf.id,
      copy_order: nftCopyOf.total_of_this + 1,
      copy_of_original,
      copy_order_original,
      wallet: userWallet.wallet_proxy,
      metadata: nftCopyOf.metadata ? nftCopyOf.metadata : defaultMetadata
    });

    // update total_of_this in the copied NFT
    Logger.log('generateNftCopy', 'Updating copied NFT total_of_this field.');
    await NFTModel.updateOne({ _id: nftCopyOf._id }, { $inc: { total_of_this: 1 } });

    // mint
    let nftData: NFTData;
    try {
      nftData = await mintNftCopy(
        userWallet.wallet_proxy,
        nftCopyOf.id,
        (mongoData._id as ObjectId).toString()
      );
    } catch (error) {
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNftCopy);
      Logger.error('generateNftCopy', error);
      return await Promise.resolve();
    }

    // update in bdd trxId and tokenId
    await NFTModel.updateOne(
      { _id: mongoData._id },
      {
        $set: {
          id: nftData.tokenId.toString(),
          trxId: nftData.receipt.transactionHash
        }
      }
    );

    await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNftCopy);
    await sendMintNotification(
      userWallet.wallet_proxy,
      channel_user_id,
      nftData.tokenId.toString()
    );

    Logger.log('generateNftCopy', 'NFT copy end.');
  } catch (error) {
    Logger.error('generateNftCopy', (error as Error).message);
  }

  // Retorna void explícitamente
  return Promise.resolve();
};

/**
 * Retrieves an NFT by its ID.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 */
export const getNftById = async (
  request: FastifyRequest<{
    Params: {
      id: number;
    };
  }>,
  reply: FastifyReply
  // eslint-disable-next-line consistent-return
): Promise<void> => {
  try {
    const { id } = request.params;

    const nft = (await NFTModel.find({ id }))?.[0];

    if (nft) {
      return await returnSuccessResponse(reply, 'NFT found', {
        image: nft.metadata.image_url,
        description: nft.metadata.description
      });
    }
    return await returnErrorResponse(reply, 404, 'NFT not found');
  } catch (error) {
    Logger.error('getNftById', error);
    return returnErrorResponse500(reply);
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
  reply: FastifyReply
  // eslint-disable-next-line consistent-return
): Promise<void> => {
  try {
    const { channel_user_id } = request.query;

    Logger.log('getLastNFT', channel_user_id);

    if (!channel_user_id) {
      return await returnErrorResponse(
        reply,
        400,
        'Missing parameters in body. You have to send: channel_user_id'
      );
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    const nft = (await NFTModel.find({ channel_user_id })).sort((a, b) => b.id - a.id)?.[0];

    if (!nft) {
      return await returnErrorResponse(reply, 404, 'NFT not found');
    }

    // Check postman requests
    const isPostman = request.headers['user-agent']?.includes('Postman');
    const returnUrl = `https://api.whatsapp.com/send/?phone=5491164629653&text=Me%20gustar%C3%ADa%20mintear%20el%20NFT%20${nft.id}`;

    if (isPostman) {
      return await returnSuccessResponse(reply, 'URL para compartir el NFT', { url: returnUrl });
    }

    reply.redirect(returnUrl);
  } catch (error) {
    Logger.error('getLastNFT', error);
    return returnErrorResponse500(reply);
  }
};

/**
 * Retrieves all NFTs for a given phone number.
 * @param {string} phone_number - The phone number to retrieve NFTs for.
 * @returns {Promise<{count: number, nfts: NFTInfo[]}>} The count and list of NFTs.
 * @throws {Error} If there's an error retrieving the NFTs.
 */
export const getPhoneNFTs = async (
  phone_number: string
): Promise<{ count: number; nfts: NFTInfo[] }> => {
  try {
    const networkConfig = await getNetworkConfig(DEFAULT_CHAIN_ID);
    const nfts = await NFTModel.find({ channel_user_id: phone_number });

    return {
      count: nfts.length,
      nfts: nfts.map((nft: INFT) => ({
        description: nft.metadata.description,
        url: `${networkConfig.marketplace_opensea_url}/${networkConfig.contracts.chatterNFTAddress}/${nft.id}`
      }))
    };
  } catch (error) {
    Logger.error('getPhoneNFTs', error);
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
  reply: FastifyReply
): Promise<{ count: number; nfts: NFTInfo[] }> => {
  const { channel_user_id: phone_number } = request.query;

  if (!isValidPhoneNumber(phone_number)) {
    return returnErrorResponse(
      reply,
      400,
      `'${phone_number}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
    );
  }

  const result = await getPhoneNFTs(phone_number);

  return returnSuccessResponse(reply, 'NFTs fetched successfully', result);
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
  reply: FastifyReply
): Promise<void> => {
  const { tokenId } = request.params;
  try {
    const nfts = await NFTModel.find({ id: tokenId });

    if (nfts.length === 0) {
      return await returnErrorResponse(reply, 400, 'NFT not found');
    }

    const nft = nfts[0];
    if (nft.original) {
      return await returnSuccessResponse(reply, 'Original NFT found', {
        original: nft,
        copies: await NFTModel.find({ copy_of: tokenId.toString() })
      });
    }

    const originalNft = (await NFTModel.find({ id: nft.copy_of }))?.[0];
    return await returnSuccessResponse(reply, 'Original NFT found', {
      original: originalNft,
      copy: nft
    });
  } catch (error) {
    Logger.error('getNftList', error);
    return returnErrorResponse500(reply);
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
      id: string; // the bdd _id!
    };
  }>,
  reply: FastifyReply
): Promise<void> => {
  // Here, it should search by the _id, as the NFT is minted with that data!
  // mintNftOriginal(address_of_user!, (mongoData._id as ObjectId).toString())
  const { id: bddId } = request.params;

  const cachedData = cache.get(`metadata-opensea-${bddId}`);
  if (cachedData) {
    return reply.status(200).send(cachedData);
  }

  const emptyResponse = {
    id: bddId,
    name: 'Chatterpay',
    description: '',
    image: defaultNftImage,
    attributes: [
      {
        trait_type: 'opensea TokenId',
        value: bddId
      },
      {
        trait_type: 'First Owner',
        value: ''
      },
      {
        trait_type: 'Original',
        value: ''
      },
      {
        trait_type: 'Copy of ID',
        value: ''
      },
      {
        trait_type: 'Order from Copy',
        value: ''
      },
      {
        trait_type: 'Copy of Original ID',
        value: ''
      },
      {
        trait_type: 'Order from Original',
        value: ''
      },
      {
        display_type: 'date',
        trait_type: 'Creation Date',
        value: ''
      },
      {
        trait_type: 'Latitude',
        value: ''
      },
      {
        trait_type: 'Longitude',
        value: ''
      },
      {
        trait_type: 'GCP Image',
        value: ''
      },
      {
        trait_type: 'IFPS Image',
        value: ''
      },
      {
        trait_type: 'ICP Image',
        value: ''
      }
    ]
  };

  try {
    if (!mongoose.Types.ObjectId.isValid(bddId)) {
      // Use standard reply.status in place of the returnSuccessResponse function, as it is called from
      // OpenSea which requires this format.
      return await reply.status(200).send(emptyResponse);
    }

    const objectId = new mongoose.Types.ObjectId(bddId);
    const nfts: INFT[] = await NFTModel.find({ _id: objectId });

    if (nfts.length === 0) {
      // Use standard reply.status in place of the returnSuccessResponse function, as it is called from
      // OpenSea which requires this format.
      return await reply.status(200).send(emptyResponse);
    }

    const nft: INFT = nfts[0];

    const response = {
      id: nft._id,
      name: 'Chatterpay',
      description: nft.metadata.description,
      image: nft.metadata.image_url.gcp ?? defaultNftImage,
      attributes: [
        {
          trait_type: 'opensea TokenId',
          value: nft.id
        },
        {
          trait_type: 'First Owner',
          value: nft.wallet
        },
        {
          trait_type: 'Original',
          value: nft.original
        },
        {
          trait_type: 'Copy of ID',
          value: nft.copy_of ?? ''
        },
        {
          trait_type: 'Order from Copy',
          value: nft.copy_order.toString()
        },
        {
          trait_type: 'Copy of Original ID',
          value: nft.copy_of_original ?? ''
        },
        {
          trait_type: 'Order from Original',
          value: nft.copy_order_original.toString()
        },
        {
          display_type: 'date',
          trait_type: 'Creation Date',
          value: nft.timestamp
        },
        {
          trait_type: 'Latitude',
          value: nft.metadata.geolocation?.latitud || ''
        },
        {
          trait_type: 'Longitude',
          value: nft.metadata.geolocation?.longitud || ''
        },
        {
          trait_type: 'GCP Image',
          value: nft.metadata.image_url.gcp || ''
        },
        {
          trait_type: 'IFPS Image',
          value: nft.metadata.image_url.ipfs || ''
        },
        {
          trait_type: 'ICP Image',
          value: nft.metadata.image_url.icp || ''
        }
      ]
    };

    cache.set(`metadata-opensea-${bddId}`, response);

    // Use standard reply.status in place of the returnSuccessResponse function, as it is called from
    // OpenSea which requires this format.
    return await reply.status(200).send(response);
  } catch (error) {
    Logger.error('getNftMetadataRequiredByOpenSea', error);
    // Use standard reply.status in place of the returnSuccessResponse function, as it is called from
    // OpenSea which requires this format.
    // avoid opensea receive error!
    return reply.status(200).send(emptyResponse);
  }
};
