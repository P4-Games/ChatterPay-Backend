import axios from 'axios';
import sharp from 'sharp';
import { Readable } from 'stream';
import PinataSDK from '@pinata/sdk';

import { Logger } from '../helpers/loggerHelper';
import {
  PINATA_JWT,
  NFT_UPLOAD_IMAGE_IPFS
} from '../config/constants';

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
  try {
    // Fetch the image from the provided URL as an arraybuffer
    const response = await axios.get(imageUrl, { responseType: 'arraybuffer' });

    // Create a buffer from the response data
    const buffer = Buffer.from(response.data, 'binary');

    // Optionally check the image format and metadata before processing
    const metadata = await sharp(buffer).metadata();

    // If the format is not supported, throw an error
    if (
      !metadata.format ||
      !['jpg', 'jpeg', 'png', 'gif'].includes(metadata.format.toLowerCase())
    ) {
      throw new Error('Unsupported image format');
    }

    // Resize the image to 800x600, keeping the aspect ratio without enlarging
    // Convert the image to JPEG with a quality of 80, and return the processed image buffer
    return await sharp(buffer)
      .resize(800, 600, { fit: 'inside', withoutEnlargement: true }) // Resize the image
      .jpeg({ quality: 80 }) // Convert to JPEG with quality 80
      .toBuffer(); // Output the processed image as a buffer
  } catch (error) {
    // Log and throw any errors encountered during the image fetching or processing
    Logger.error('downloadAndProcessImage', error);
    throw error;
  }
}
