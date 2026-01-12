import PinataSDK from '@pinata/sdk';
import { Readable } from 'stream';
import { NFT_UPLOAD_IMAGE_IPFS, PINATA_IPFS_URL, PINATA_JWT } from '../../config/constants';
import { Logger } from '../../helpers/loggerHelper';

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

      const url = `${PINATA_IPFS_URL}/${result.IpfsHash}`;
      Logger.log('uploadToIpfs', `Image successfully uploaded to IPFS: ${url}`);
      return url;
    } catch (error) {
      Logger.error('uploadToIpfs', error);
      throw error;
    }
  }
};
