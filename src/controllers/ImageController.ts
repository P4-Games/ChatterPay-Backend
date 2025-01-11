import { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import { Logger } from '../helpers/loggerHelper';
import { getUser } from '../services/userService';
import { uploadToICP, uploadToIpfs, downloadAndProcessImage } from '../services/uploadService';
import {
  returnErrorResponse,
  returnSuccessResponse,
  returnErrorResponse500
} from '../helpers/requestHelper';

interface UploadBody {
  phone_number: string;
  image_url: string;
}

interface UploadResponse {
  success: boolean;
  message: string;
  icp_url?: string;
  ipfs_url?: string;
  error?: string;
}

/**
 * Processes and uploads an image to ICP and IPFS.
 * @param {string} imageUrl - The URL of the image to download and process.
 * @param {string} fileName - The file name to be used for the image upload.
 * @returns {Promise<UploadResponse>} The result of the upload operation.
 */
async function processAndUploadImage(imageUrl: string, fileName: string): Promise<UploadResponse> {
  try {
    const processedImageBuffer = await downloadAndProcessImage(imageUrl);

    const icpUrl = await uploadToICP(processedImageBuffer, fileName);
    const ipfsUrl = await uploadToIpfs(processedImageBuffer, fileName);

    return {
      success: true,
      message: 'Image successfully uploaded to ICP and IPFS',
      icp_url: icpUrl,
      ipfs_url: ipfsUrl
    };
  } catch (error) {
    Logger.error('processAndUploadImage', error);
    return {
      success: false,
      message: 'Error processing and uploading the image',
      error: (error as Error).message
    };
  }
}

/**
 * Handles the image upload process for a user.
 * @param {FastifyRequest} request - The Fastify request object containing the phone number and image URL.
 * @param {FastifyReply} reply - The Fastify reply object used to send the response.
 * @returns {Promise<FastifyReply>} The Fastify reply object with the result of the upload operation.
 */
export const uploadImage: RouteHandlerMethod = async (
  request: FastifyRequest,
  reply: FastifyReply
): Promise<FastifyReply> => {
  try {
    if (!request.body) {
      return await returnErrorResponse(reply, 400, 'You have to send a body with this request');
    }

    const { phone_number, image_url } = request.body as UploadBody;

    if (!phone_number) {
      Logger.warn('uploadImage', 'Phone number not provided');
      return await returnErrorResponse(reply, 400, 'Phone number not provided');
    }

    if (!image_url) {
      Logger.warn('uploadImage', 'Image URL not provided');
      return await returnErrorResponse(reply, 400, 'Image URL not provided');
    }

    const user = await getUser(phone_number);
    if (!user) {
      Logger.warn('uploadImage', `User not found: ${phone_number}`);
      return await returnErrorResponse(reply, 404, 'User not found');
    }

    const fileName = `profile_${phone_number}_${Date.now()}.jpg`;
    const uploadResult = await processAndUploadImage(image_url, fileName);

    if (uploadResult.success) {
      user.photo = uploadResult.ipfs_url ?? '';
      await user.save();

      Logger.log('uploadImage', uploadResult);
      return await returnSuccessResponse(reply, 'Image uploaded successfully', {
        icp_url: uploadResult.icp_url,
        ipfs_url: uploadResult.ipfs_url
      });
    }

    Logger.error('uploadImage', uploadResult.error);
    return await returnErrorResponse(reply, 500, 'Error uploading image', uploadResult.error);
  } catch (error) {
    Logger.error('uploadImage', error);
    return returnErrorResponse500(reply);
  }
};
