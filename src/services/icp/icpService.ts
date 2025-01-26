import { createHash } from 'crypto';
import { HttpAgent } from '@dfinity/agent';
import { AssetManager } from '@dfinity/assets';
import { Ed25519KeyIdentity } from '@dfinity/identity';
import { mnemonicToSeed, validateMnemonic } from 'bip39';

import { Logger } from '../../helpers/loggerHelper';
import {
  ICP_URL,
  ICP_MNEMONIC,
  ICP_CANISTER_ID,
  NFT_UPLOAD_IMAGE_ICP
} from '../../config/constants';

/**
 * Generates an Ed25519KeyIdentity from a mnemonic seed phrase.
 *
 * @param {string} mnemonic - The seed phrase used to generate the identity.
 * @returns {Promise<Ed25519KeyIdentity>} The generated identity.
 * @throws {Error} Throws an error if the mnemonic is invalid.
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
 * Creates an HTTP agent using the provided identity.
 *
 * @param {Ed25519KeyIdentity} identity - The identity used to create the agent.
 * @returns {Promise<HttpAgent>} The created HttpAgent instance.
 */
async function createAgent(identity: Ed25519KeyIdentity): Promise<HttpAgent> {
  const agent = new HttpAgent({
    host: ICP_URL,
    identity
  });

  return agent;
}

export const icpService = {
  /**
   * Uploads an image to ICP (Internet Computer Protocol).
   *
   * @param {Buffer} imageBuffer - The image buffer to upload.
   * @param {string} fileName - The name of the file to upload.
   * @returns {Promise<string>} The URL of the uploaded image.
   * @throws {Error} Throws an error if the upload fails or if required environment variables are missing.
   */
  uploadToICP: async (imageBuffer: Buffer, fileName: string): Promise<string> => {
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
};
