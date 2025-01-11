import axios from 'axios';
import sharp from 'sharp';
import dotenv from 'dotenv';
import { Readable } from 'stream';
import PinataSDK from '@pinata/sdk';
import { createHash } from 'crypto';
import { HttpAgent } from '@dfinity/agent';
import { AssetManager } from '@dfinity/assets';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { mnemonicToSeed, validateMnemonic } from 'bip39';

import { Logger } from '../helpers/loggerHelper';
import {
  PINATA_JWT,
  ICP_MNEMONIC,
  ICP_CANISTER_ID,
  NFT_UPLOAD_IMAGE_ICP,
  NFT_UPLOAD_IMAGE_IPFS
} from '../config/constants';

dotenv.config();

// Helper functions

/**
 * Generates an Ed25519KeyIdentity from a mnemonic seed phrase
 * @param mnemonic The seed phrase used to generate the identity
 * @returns The generated identity
 * @throws Error if the mnemonic is invalid
 */
async function generateIdentityFromMnemonic(mnemonic: string): Promise<Ed25519KeyIdentity> {
  const isValidMnemonic = validateMnemonic(mnemonic);
  if (!isValidMnemonic) {
    throw new Error('The seed phrase is invalid');
  }
  const seed = await mnemonicToSeed(mnemonic);
  const privateKey = createHash('sha512').update(seed).digest().slice(0, 32);
  // @ts-expect-error 'it is ok'
  return Ed25519KeyIdentity.fromSecretKey(privateKey);
}

/**
 * Creates an HTTP agent using the provided identity
 * @param identity The identity used to create the agent
 * @returns The created HttpAgent instance
 */
async function createAgent(identity: Ed25519KeyIdentity): Promise<HttpAgent> {
  const agent = new HttpAgent({
    host: 'https://ic0.app',
    identity
  });

  return agent;
}

/**
 * Fetches the details of an image from a given URL
 * @param imageUrl The URL of the image to fetch
 * @returns The image details including the file name, width, height, and image buffer
 * @throws Error if the image could not be downloaded
 */
export const getImageDetails = async (imageUrl: string) => {
  try {
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
    const imageBuffer = Buffer.from(response.data, 'binary');
    const fileName = imageUrl.split('/').pop();
    const width = 800;
    const height = 600;
    return { fileName, width, height, imageBuffer };
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Error downloading the image: ${error.message}`);
    } else {
      throw new Error('Unknown error downloading the image');
    }
  }
};

// Upload functions

/**
 * Uploads an image to ICP (Internet Computer Protocol)
 * @param imageBuffer The image buffer to upload
 * @param fileName The name of the file to upload
 * @returns The URL of the uploaded image
 * @throws Error if the upload fails
 */
export async function uploadToICP(imageBuffer: Buffer, fileName: string): Promise<string> {
  if (!NFT_UPLOAD_IMAGE_ICP) {
    Logger.info('uploadToICP', 'Upload NFT image to ICP disabled');
    return '';
  }

  Logger.info('uploadToICP', 'Uploading image to ICP');
  const FOLDER_UPLOAD = 'uploads';

  if (!ICP_CANISTER_ID) {
    throw new Error('CANISTER_ID is not set in the environment variables');
  }

  if (!ICP_MNEMONIC) {
    throw new Error('MNEMONIC is not set in the environment variables');
  }

  const identity = await generateIdentityFromMnemonic(ICP_MNEMONIC);
  const agent = await createAgent(identity);

  const assetManager = new AssetManager({ canisterId: ICP_CANISTER_ID, agent });
  const batch = assetManager.batch();
  const url = `https://${ICP_CANISTER_ID}.icp0.io/${FOLDER_UPLOAD}/${fileName}`;

  try {
    const key = await batch.store(imageBuffer, {
      path: `/${FOLDER_UPLOAD}`,
      fileName
    });

    await batch.commit({
      onProgress: ({ current, total }) => {
        Logger.log('uploadToICP', `Upload progress to ICP: ${(current / total) * 100}%`);
      }
    });
    Logger.log('uploadToICP', 'this is my key', key);
    Logger.log('uploadToICP', `Image successfully uploaded to ICP: ${url}`);
    return url;
  } catch (error: unknown) {
    if (error instanceof Error) {
      if (error.message.includes('asset already exists')) {
        Logger.log('uploadToICP', `The image already exists on ICP: ${url}`);
        return `${url}`;
      }
      Logger.error('uploadToICP', error);
      throw error;
    } else {
      Logger.error('uploadToICP', error);
      throw new Error('Unknown error');
    }
  }
}

/**
 * Uploads an image to IPFS (InterPlanetary File System)
 * @param imageBuffer The image buffer to upload
 * @param fileName The name of the file to upload
 * @returns The URL of the uploaded image
 * @throws Error if the upload fails
 */
export async function uploadToIpfs(imageBuffer: Buffer, fileName: string): Promise<string> {
  if (!NFT_UPLOAD_IMAGE_IPFS) {
    Logger.info('uploadToIpfs', 'Upload NFT image to IPFS disabled');
    return '';
  }

  Logger.info('uploadToIpfs', 'Uploading image to IPFS');

  try {
    const pinata = new PinataSDK({ pinataJWTKey: PINATA_JWT });
    const readableStream = new Readable();
    readableStream.push(imageBuffer);
    readableStream.push(null);

    const result = await pinata.pinFileToIPFS(readableStream, {
      pinataMetadata: { name: fileName },
      pinataOptions: { cidVersion: 0 }
    });

    const url = `https://gateway.pinata.cloud/ipfs/${result.IpfsHash}`;
    Logger.log('uploadToIpfs', `Image successfully uploaded to IPFS: ${url}`);
    return url;
  } catch (error) {
    Logger.error('uploadToIpfs', error);
    throw error;
  }
}

/**
 * Downloads and processes an image by resizing it and converting it to JPEG format
 * @param imageUrl The URL of the image to download and process
 * @returns The processed image buffer
 * @throws Error if the image processing fails
 */
export async function downloadAndProcessImage(imageUrl: string): Promise<Buffer> {
  const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data, 'binary');

  return sharp(buffer)
    .resize(800, 600, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
}
