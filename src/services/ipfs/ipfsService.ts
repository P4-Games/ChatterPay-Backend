import { Readable } from 'stream';
import PinataSDK from '@pinata/sdk';

import { Logger } from '../../helpers/loggerHelper';
import { PINATA_JWT, NFT_UPLOAD_IMAGE_IPFS } from '../../config/constants';

export const ipfsService = {
  /*
   * Uploads an image to IPFS (InterPlanetary File System)
   * @param imageBuffer The image buffer to upload
   * @param fileName The name of the file to upload
   * @returns The URL of the uploaded image
   * @throws Error if the upload fails
   */
  uploadToIpfs: async (imageBuffer: Buffer, fileName: string): Promise<string> => {
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
};
