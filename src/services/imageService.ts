import axios from 'axios';
import sharp from 'sharp';

import { Logger } from '../helpers/loggerHelper';

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
