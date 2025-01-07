import { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import { User } from '../models/user';
import { Logger } from '../helpers/loggerHelper';
import { uploadToICP, uploadToIpfs, downloadAndProcessImage } from '../services/uploadService';
import { returnErrorResponse, returnSuccessResponse } from '../helpers/requestHelper';

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
 *
 * @param imageUrl
 * @param fileName
 * @returns
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
    Logger.error('Error processing and uploading the image:', error);
    return {
      success: false,
      message: 'Error processing and uploading the image',
      error: (error as Error).message
    };
  }
}

/**
 *
 * @param request
 * @param reply
 * @returns
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
      Logger.warn('Phone number not provided');
      return await returnErrorResponse(reply, 400, 'Phone number not provided');
    }

    if (!image_url) {
      Logger.warn('Image URL not provided');
      return await returnErrorResponse(reply, 400, 'Image URL not provided');
    }

    const user = await User.findOne({ phone_number });
    if (!user) {
      Logger.warn('User not found:', phone_number);
      return await returnErrorResponse(reply, 404, 'User not found');
    }

    const fileName = `profile_${phone_number}_${Date.now()}.jpg`;
    const uploadResult = await processAndUploadImage(image_url, fileName);

    if (uploadResult.success) {
      user.photo = uploadResult.ipfs_url ?? '';
      await user.save();

      Logger.log('Image uploaded successfully:', uploadResult);
      return await returnSuccessResponse(reply, 'Image uploaded successfully', {
        icp_url: uploadResult.icp_url,
        ipfs_url: uploadResult.ipfs_url
      });
    }

    Logger.error('Error uploading image:', uploadResult.error);
    return await returnErrorResponse(reply, 500, 'Error uploading image', uploadResult.error);
  } catch (error) {
    Logger.error('Error uploading image:', error);
    return returnErrorResponse(reply, 500, 'Internal Server Error');
  }
};
