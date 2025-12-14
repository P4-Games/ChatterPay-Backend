import { ethers } from 'ethers';
import type { FastifyReply, FastifyRequest } from 'fastify';
import mongoose, { type ObjectId } from 'mongoose';
import {
  CHATIZALO_PHONE_NUMBER,
  COMMON_REPLY_OPERATION_IN_PROGRESS,
  COMMON_REPLY_WALLET_NOT_CREATED,
  DEFAULT_CHAIN_ID,
  defaultNftImage,
  WHATSAPP_API_URL
} from '../config/constants';
import { Logger } from '../helpers/loggerHelper';
import {
  returnErrorResponse,
  returnErrorResponse500,
  returnSuccessResponse
} from '../helpers/requestHelper';
import { delaySeconds } from '../helpers/timeHelper';
import { isShortUrl, isValidPhoneNumber, isValidUrl } from '../helpers/validationHelper';
import NFTModel, { type INFT, type INFTMetadata } from '../models/nftModel';
import { NotificationEnum } from '../models/templateModel';
import type { IUser, IUserWallet } from '../models/userModel';
import { userReachedOperationLimit } from '../services/blockchainService';
import { cacheService } from '../services/cache/cacheService';
import { icpService } from '../services/icp/icpService';
import { downloadAndProcessImage } from '../services/imageService';
import { ipfsService } from '../services/ipfs/ipfsService';
import { mongoBlockchainService } from '../services/mongo/mongoBlockchainService';
import { mongoUserService } from '../services/mongo/mongoUserService';
import {
  getNotificationTemplate,
  persistNotification,
  sendMintNotification
} from '../services/notificationService';
import { secService } from '../services/secService';
import {
  closeOperation,
  getOrCreateUser,
  getUser,
  getUserWallet,
  getUserWalletByChainId,
  hasPhoneAnyOperationInProgress,
  openOperation
} from '../services/userService';
import { getChatterPayNFTABI } from '../services/web3/abiService';
import { gasService } from '../services/web3/gasService';
import { CacheNames, ConcurrentOperationsEnum } from '../types/commonType';

export interface NFTInfo {
  description: string;
  url: string;
}

interface NFTMintData {
  contractAddress: string;
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
    latitude: '',
    longitude: ''
  }
};

type generateNftOriginalInputs = {
  channel_user_id: string;
  url: string;
  description: string;
  latitude: string;
  longitude: string;
};

type generateNftCopyInputs = {
  channel_user_id: string;
  id: string;
};

/**
 * Mints an NFT on the Ethereum network.
 * @param {string} recipientAddress - The address to receive the minted NFT.
 * @param {string} name - The name of the NFT.
 * @param {string} description - The description of the NFT.
 * @param {string} image - The URL of the image associated with the NFT.
 * @returns {Promise<{ receipt: ethers.ContractReceipt, tokenId: ethers.BigNumber }>} An object containing
 * the transaction receipt and the minted token ID.
 * @throws {Error} If minting fails.
 */
const mintNftOriginal = async (
  recipientAddress: string,
  bddIdToUseAsUri: string
): Promise<NFTMintData> => {
  try {
    const networkConfig = await mongoBlockchainService.getNetworkConfig(DEFAULT_CHAIN_ID);
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const bs = secService.get_bs(provider);
    const contractABI: ethers.ContractInterface = await getChatterPayNFTABI();
    const nftContract = new ethers.Contract(
      networkConfig.contracts.chatterNFTAddress,
      contractABI,
      bs
    );

    Logger.log(
      'mintNftOriginal',
      recipientAddress,
      networkConfig.contracts.chatterNFTAddress,
      networkConfig.rpc,
      bs.address
    );

    const gasLimit = await gasService.getDynamicGas(nftContract, 'mintOriginal', [
      recipientAddress,
      bddIdToUseAsUri
    ]);

    const gasPrice = await provider.getGasPrice();
    const tx = await nftContract.mintOriginal(recipientAddress, bddIdToUseAsUri, {
      gasLimit,
      gasPrice
    });

    Logger.log('mintNftOriginal', 'Transaction sent: ', tx.hash);

    const receipt = await tx.wait();
    Logger.log('mintNftOriginal', 'Transaction confirmed: ', receipt.transactionHash);

    const event = receipt.events?.find((e: { event: string }) => e.event === 'Transfer');

    if (!event) {
      throw new Error('Minted event not found in transaction receipt');
    }

    const tokenId = event.args?.tokenId;
    Logger.log('mintNftOriginal', 'Token ID minted: ', tokenId.toString());

    return { receipt, tokenId, contractAddress: networkConfig.contracts.chatterNFTAddress };
  } catch (error) {
    Logger.error('mintNftOriginal', error);
    throw new Error('Minting NFT Original failed');
  }
};

const mintNftCopy = async (
  recipientAddress: string,
  originalTOkenId: string,
  bddIdToUseAsUri: string
): Promise<NFTMintData> => {
  try {
    const networkConfig = await mongoBlockchainService.getNetworkConfig(DEFAULT_CHAIN_ID);
    const provider = new ethers.providers.JsonRpcProvider(networkConfig.rpc);
    const bs = secService.get_bs(provider);
    const contractABI: ethers.ContractInterface = await getChatterPayNFTABI();
    const nftContract = new ethers.Contract(
      networkConfig.contracts.chatterNFTAddress,
      contractABI,
      bs
    );

    Logger.log(
      'mintNftCopy',
      recipientAddress,
      networkConfig.contracts.chatterNFTAddress,
      networkConfig.rpc,
      bs.address
    );

    const gasLimit = await gasService.getDynamicGas(nftContract, 'mintCopy', [
      recipientAddress,
      parseInt(originalTOkenId, 10),
      bddIdToUseAsUri
    ]);

    const gasPrice = await provider.getGasPrice();
    const tx = await nftContract.mintCopy(
      recipientAddress,
      parseInt(originalTOkenId, 10),
      bddIdToUseAsUri,
      { gasLimit, gasPrice }
    );

    Logger.log('mintNftCopy', 'Transaction sent: ', tx.hash);

    const receipt = await tx.wait();
    Logger.log('mintNftCopy', 'Transaction confirmed: ', receipt.transactionHash);

    const event = receipt.events?.find((e: { event: string }) => e.event === 'Transfer');
    if (!event) {
      throw new Error('Minted event not found in transaction receipt');
    }

    const tokenId = event.args?.tokenId;
    Logger.log('mintNftCopy', 'NFT Copy ID minted: ', tokenId.toString());

    return { receipt, tokenId, contractAddress: networkConfig.contracts.chatterNFTAddress };
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
    Body: generateNftOriginalInputs;
    Querystring?: { lastBotMsgDelaySeconds?: number };
  }>,
  reply: FastifyReply
  // eslint-disable-next-line consistent-return
) => {
  let logKey = `[op:mintNft:${''}]`;
  if (!request.body) {
    return returnErrorResponse(
      'generateNftOriginal',
      logKey,
      reply,
      400,
      'You have to send a body with this request'
    );
  }

  const { channel_user_id, url, description, latitude, longitude } = request.body;
  const lastBotMsgDelaySeconds = request.query?.lastBotMsgDelaySeconds || 0;

  if (!channel_user_id || !url || !description) {
    return returnErrorResponse(
      'generateNftOriginal',
      logKey,
      reply,
      400,
      'Missing parameters in body. You have to send: channel_user_id, url, description, latitude, longitude'
    );
  }

  if (!isValidPhoneNumber(channel_user_id)) {
    return returnErrorResponse(
      'generateNftOriginal',
      logKey,
      reply,
      400,
      `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
    );
  }

  logKey = `[op:mintNft:${channel_user_id}]`;
  if (!isValidUrl(url)) {
    return returnErrorResponse(
      'generateNftOriginal',
      logKey,
      reply,
      400,
      'The provided URL is not valid.'
    );
  }

  if (isShortUrl(url)) {
    return returnErrorResponse('generateNftOriginal', logKey, reply, 400, 'Short Url not allowed');
  }

  const fromUser: IUser | null = await getUser(channel_user_id);
  const userWalletByChainId: IUserWallet | null = await getUserWallet(
    channel_user_id,
    DEFAULT_CHAIN_ID
  );
  if (!fromUser || !userWalletByChainId) {
    Logger.info('generateNftOriginal', logKey, COMMON_REPLY_WALLET_NOT_CREATED);
    // must return 200, so the bot displays the message instead of an error!
    return returnSuccessResponse(reply, COMMON_REPLY_WALLET_NOT_CREATED);
  }

  const userOperations = await hasPhoneAnyOperationInProgress(channel_user_id);
  if (userOperations) {
    const { message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.concurrent_operation
    );
    await persistNotification(channel_user_id, message, NotificationEnum.concurrent_operation);

    const validationError = `Concurrent mint original NFT for wallet ${userWalletByChainId.wallet_proxy}, phone: ${channel_user_id}.`;
    Logger.log('generateNftOriginal', logKey, `generateNftOriginal: ${validationError}`);

    // must return 200, so the bot displays the message instead of an error!
    return returnSuccessResponse(reply, message);
  }

  const userReachedOpLimit = await userReachedOperationLimit(
    request.server.networkConfig,
    channel_user_id,
    'mint_nft'
  );
  if (userReachedOpLimit) {
    const { message } = await getNotificationTemplate(
      channel_user_id,
      NotificationEnum.daily_limit_reached
    );
    Logger.info('generateNftOriginal', logKey, `${message}`);

    await persistNotification(channel_user_id, message, NotificationEnum.daily_limit_reached);

    // must return 200, so the bot displays the message instead of an error!
    return returnSuccessResponse(reply, message);
  }

  await openOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);

  // optimistic response
  Logger.log('generateNftOriginal', logKey, 'sending notification: operation in progress');
  await returnSuccessResponse(reply, COMMON_REPLY_OPERATION_IN_PROGRESS);

  let processedImage;
  try {
    Logger.info('generateNftOriginal', logKey, 'Fetching NFT image');
    processedImage = await downloadAndProcessImage(url);
  } catch (error) {
    await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);
    Logger.error(
      'generateNftOriginal',
      logKey,
      'Error downloading the NFT image:',
      (error as Error).message
    );
    return Promise.resolve();
  }

  // Save the initial NFT details in the database.
  let mongoData;
  try {
    Logger.info('generateNftOriginal', logKey, 'Saving NFT Data into MongoDB');
    mongoData = await NFTModel.create({
      channel_user_id,
      wallet: userWalletByChainId.wallet_proxy,
      id: '0', // tbc later nftData.tokenId.toString(),
      trxId: '0', // tbc later nftData.receipt.transactionHash,
      timestamp: new Date(),
      original: true,
      total_of_this: 1,
      copy_of: null,
      copy_of_original: null,
      copy_order: 1,
      copy_order_original: 1,
      minted_contract_address: '0x', // tbc later nftData.contractAddress,
      metadata: {
        image_url: {
          gcp: url || '',
          icp: '',
          ipfs: ''
        },
        description: description || '',
        geolocation: {
          latitude: latitude || '',
          longitude: longitude || ''
        }
      },
      chain_id: request.server.networkConfig.chainId
    });
  } catch (error) {
    await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);
    Logger.error(
      'generateNftOriginal',
      logKey,
      'Error saving NFT data into DB.',
      (error as Error).message
    );
    return Promise.resolve(); // If the initial creation fails, it makes no sense to continue.
  }

  let nftMintData: NFTMintData;
  try {
    nftMintData = await mintNftOriginal(
      userWalletByChainId.wallet_proxy,
      (mongoData._id as ObjectId).toString()
    );
  } catch (error) {
    await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);
    Logger.error('generateNftOriginal', logKey, 'Error minting NFT', error);
    return Promise.resolve();
  }
  const nftMintedId = nftMintData.tokenId.toString();

  // Update in bdd trxId and tokenId
  try {
    Logger.info('generateNftOriginal', logKey, 'Updating tokenId and trxId in the database');
    await NFTModel.updateOne(
      { _id: mongoData._id },
      {
        $set: {
          id: nftMintedId,
          trxId: nftMintData.receipt.transactionHash || '',
          minted_contract_address: nftMintData.contractAddress
        }
      }
    );
  } catch (error) {
    Logger.error(
      'generateNftOriginal',
      logKey,
      'Error updating NFT in bdd',
      (error as Error).message
    );
  }

  const fileName = `${channel_user_id.toString()}_${Date.now()}.jpg`;
  let ipfsImageUrl = '';
  let icpImageUrl = '';

  try {
    ipfsImageUrl = await ipfsService.uploadToIpfs(processedImage, fileName);
  } catch (error) {
    Logger.warn(
      'generateNftOriginal',
      logKey,
      'Error uploading the image to IPFS:',
      (error as Error).message
    );
    // No error is thrown here to continue with the process
  }

  try {
    icpImageUrl = await icpService.uploadToICP(processedImage, fileName);
  } catch (error) {
    Logger.warn(
      'generateNftOriginal',
      logKey,
      'Error uploading the image to ICP:',
      (error as Error).message
    );
    // No error is thrown here to continue with the process
  }

  // Update IPFS & ICP urls in bdd
  try {
    Logger.info('generateNftOriginal', logKey, 'Updating IPFS and ICP URLs in the database');
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
    Logger.error(
      'generateNftOriginal',
      logKey,
      'Error updating NFT in bdd',
      (error as Error).message
    );
  }

  await mongoUserService.updateUserOperationCounter(channel_user_id, 'mint_nft');

  await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNft);

  if (lastBotMsgDelaySeconds > 0) {
    Logger.log(
      'generateNftOriginal',
      logKey,
      `Delaying bot notification ${lastBotMsgDelaySeconds} seconds.`
    );
    await delaySeconds(lastBotMsgDelaySeconds);
  }
  await sendMintNotification(userWalletByChainId.wallet_proxy, channel_user_id, nftMintedId);
  Logger.log('generateNftOriginal', logKey, 'NFT minting end.');
};

/**
 * Mints an existing NFT for a user.
 * @param {FastifyRequest} request - The Fastify request object.
 * @param {FastifyReply} reply - The Fastify reply object.
 * @returns {Promise<boolean>} True if minting was successful.
 */
export const generateNftCopy = async (
  request: FastifyRequest<{
    Body: generateNftCopyInputs;
    Querystring?: { lastBotMsgDelaySeconds?: number };
  }>,
  reply: FastifyReply
  // eslint-disable-next-line consistent-return
) => {
  let logKey = `[op:mintNftCopy:${''}]`;
  try {
    if (!request.body) {
      return await returnErrorResponse(
        'generateNftCopy',
        logKey,
        reply,
        400,
        'You have to send a body with this request'
      );
    }

    const { channel_user_id, id } = request.body;
    const lastBotMsgDelaySeconds = request.query?.lastBotMsgDelaySeconds || 0;

    if (!channel_user_id) {
      return await returnErrorResponse(
        'generateNftCopy',
        logKey,
        reply,
        400,
        'Missing parameters in body. You have to send: channel_user_id'
      );
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        'generateNftCopy',
        logKey,
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    logKey = `[op:mintNftCopy:${channel_user_id}]`;

    // Verify that the NFT to copy exists
    const nfts: INFT[] = await NFTModel.find({ id });
    if (!nfts || nfts.length === 0) {
      const msgError = `NFT with id ${id} not found`;
      Logger.info('generateNftCopy', logKey, `${msgError}`);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, msgError);
    }
    const nftCopyOf = nfts[0];

    const userOperations = await hasPhoneAnyOperationInProgress(channel_user_id);
    if (userOperations) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.concurrent_operation
      );
      await persistNotification(channel_user_id, message, NotificationEnum.concurrent_operation);

      const validationError = `Concurrent mint copy NFT for phone: ${channel_user_id}.`;
      Logger.info('generateNftCopy', logKey, `${validationError}`);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, message);
    }

    const userReachedOpLimit = await userReachedOperationLimit(
      request.server.networkConfig,
      channel_user_id,
      'mint_nft_copy'
    );
    if (userReachedOpLimit) {
      const { message } = await getNotificationTemplate(
        channel_user_id,
        NotificationEnum.daily_limit_reached
      );

      await persistNotification(channel_user_id, message, NotificationEnum.daily_limit_reached);

      Logger.info('generateNftOriginal', logKey, `${message}`);
      // must return 200, so the bot displays the message instead of an error!
      return await returnSuccessResponse(reply, message);
    }

    // optimistic response
    Logger.log('generateNftOriginal', logKey, 'sending notification: operation in progress');
    await returnSuccessResponse(reply, COMMON_REPLY_OPERATION_IN_PROGRESS);

    await openOperation(channel_user_id, ConcurrentOperationsEnum.MintNftCopy);

    // search by NFT original
    let copy_of_original = nftCopyOf.id;
    let copy_order_original = nftCopyOf.total_of_this + 1;

    if (!nftCopyOf.original) {
      // If it is being copied from a copy, then the original is sought.
      Logger.log('generateNftCopy', logKey, 'Searching by nft original.');
      const nftOriginal: INFT | null = await NFTModel.findOne({
        id: nftCopyOf.copy_of_original
      });
      if (nftOriginal) {
        copy_of_original = nftOriginal.id;
        copy_order_original = nftOriginal.total_of_this + 1;

        // update total_of_this in the ORIGINAL NFT
        Logger.log('generateNftCopy', logKey, 'Updating original NFT total_of_this field.');
        await NFTModel.updateOne({ _id: nftOriginal._id }, { $inc: { total_of_this: 1 } });
      }
    }

    Logger.log('generateNftCopy', logKey, 'Saving NFT copy in database');
    const fastify = request.server;
    const chatterpayProxyAddress: string = fastify.networkConfig.contracts.chatterPayAddress;
    const { factoryAddress } = fastify.networkConfig.contracts;
    const user: IUser = await getOrCreateUser(
      channel_user_id,
      chatterpayProxyAddress,
      factoryAddress
    );
    const userWallet: IUserWallet | null = getUserWalletByChainId(user.wallets, DEFAULT_CHAIN_ID);
    if (!userWallet) {
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNftCopy);
      return await returnErrorResponse(
        'generateNftCopy',
        logKey,
        reply,
        400,
        'Wallet User doesnt exists.'
      );
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
      minted_contract_address: '0x',
      wallet: userWallet.wallet_proxy,
      metadata: nftCopyOf.metadata ? nftCopyOf.metadata : defaultMetadata,
      chain_id: fastify.networkConfig.chainId
    });

    // update total_of_this in the copied NFT
    Logger.log('generateNftCopy', logKey, 'Updating copied NFT total_of_this field.');
    await NFTModel.updateOne({ _id: nftCopyOf._id }, { $inc: { total_of_this: 1 } });

    // mint
    let nftMintData: NFTMintData;
    try {
      nftMintData = await mintNftCopy(
        userWallet.wallet_proxy,
        nftCopyOf.id,
        (mongoData._id as ObjectId).toString()
      );
    } catch (error) {
      await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNftCopy);
      Logger.error('generateNftCopy', logKey, error);
      return await Promise.resolve();
    }

    // update in bdd trxId and tokenId
    await NFTModel.updateOne(
      { _id: mongoData._id },
      {
        $set: {
          id: nftMintData.tokenId.toString(),
          trxId: nftMintData.receipt.transactionHash || '',
          minted_contract_address: nftMintData.contractAddress
        }
      }
    );

    await mongoUserService.updateUserOperationCounter(channel_user_id, 'mint_nft_copy');

    await closeOperation(channel_user_id, ConcurrentOperationsEnum.MintNftCopy);

    if (lastBotMsgDelaySeconds > 0) {
      Logger.log(
        'generateNftCopy',
        logKey,
        `Delaying bot notification ${lastBotMsgDelaySeconds} seconds.`
      );
      await delaySeconds(lastBotMsgDelaySeconds);
    }
    await sendMintNotification(
      userWallet.wallet_proxy,
      channel_user_id,
      nftMintData.tokenId.toString()
    );

    Logger.log('generateNftCopy', logKey, 'NFT copy end.');
  } catch (error) {
    Logger.error('generateNftCopy', logKey, (error as Error).message);
  }
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
    return await returnErrorResponse('getNftById', '', reply, 404, 'NFT not found');
  } catch (error) {
    Logger.error('getNftById', error);
    return returnErrorResponse500('getNftById', '', reply);
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
        'getLastNFT',
        '',
        reply,
        400,
        'Missing parameters in body. You have to send: channel_user_id'
      );
    }

    if (!isValidPhoneNumber(channel_user_id)) {
      return await returnErrorResponse(
        'getLastNFT',
        '',
        reply,
        400,
        `'${channel_user_id}' is invalid. 'channel_user_id' parameter must be a phone number (without spaces or symbols)`
      );
    }

    const nft = (await NFTModel.find({ channel_user_id })).sort((a, b) => b.id - a.id)?.[0];

    if (!nft) {
      return await returnErrorResponse('getLastNFT', '', reply, 404, 'NFT not found');
    }

    // Check postman requests
    const isPostman = request.headers['user-agent']?.includes('Postman');

    const returnUrl = `${WHATSAPP_API_URL}/send/?phone=${CHATIZALO_PHONE_NUMBER}&text=Me%20gustar%C3%ADa%20mintear%20el%20NFT%20${nft.id}`;

    if (isPostman) {
      return await returnSuccessResponse(reply, 'URL para compartir el NFT', { url: returnUrl });
    }

    reply.redirect(returnUrl);
  } catch (error) {
    Logger.error('getLastNFT', error);
    return returnErrorResponse500('getLastNFT', '', reply);
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
    const networkConfig = await mongoBlockchainService.getNetworkConfig(DEFAULT_CHAIN_ID);
    const nfts = await NFTModel.find({ channel_user_id: phone_number });

    return {
      count: nfts.length,
      nfts: nfts.map((nft: INFT) => ({
        description: nft.metadata.description,
        url: `${networkConfig.marketplaceOpenseaUrl}/${networkConfig.contracts.chatterNFTAddress}/${nft.id}`
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
      'getAllNFTs',
      '',
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
      return await returnErrorResponse('getNftList', '', reply, 400, 'NFT not found');
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
    return returnErrorResponse500('getNftList', '', reply);
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

  const cachedData = cacheService.get<string>(CacheNames.OPENSEA, `metadata-opensea-${bddId}`);

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
          value: nft.metadata.geolocation?.latitude || ''
        },
        {
          trait_type: 'Longitude',
          value: nft.metadata.geolocation?.longitude || ''
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

    cacheService.set(CacheNames.OPENSEA, `metadata-opensea-${bddId}`, response);

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
