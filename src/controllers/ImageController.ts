import { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import { User } from '../models/user';
import { returnErrorResponse, returnSuccessResponse } from '../utils/responseFormatter';
import { uploadToICP, uploadToIpfs, downloadAndProcessImage } from '../utils/uploadServices';

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

async function processAndUploadImage(imageUrl: string, fileName: string): Promise<UploadResponse> {
    try {
        const processedImageBuffer = await downloadAndProcessImage(imageUrl);

        const icpUrl = await uploadToICP(processedImageBuffer, fileName);
        const ipfsUrl = await uploadToIpfs(processedImageBuffer, fileName);

        return {
            success: true,
            message: 'Imagen subida exitosamente a ICP e IPFS',
            icp_url: icpUrl,
            ipfs_url: ipfsUrl,
        };
    } catch (error) {
        console.error('Error procesando y subiendo la imagen:', error);
        return {
            success: false,
            message: 'Error al procesar y subir la imagen',
            error: (error as Error).message,
        };
    }
}

export const uploadImage: RouteHandlerMethod = async (
    request: FastifyRequest,
    reply: FastifyReply,
): Promise<FastifyReply> => {
    try {
        const { phone_number, image_url } = request.body as UploadBody;

        if (!phone_number) {
            console.warn('Phone number not provided');
            return await returnErrorResponse(reply, 400, 'Phone number not provided');
        }

        if (!image_url) {
            console.warn('Image URL not provided');
            return await returnErrorResponse(reply, 400, 'Image URL not provided');
        }

        const user = await User.findOne({ phone_number });
        if (!user) {
            console.warn('User not found:', phone_number);
            return await returnErrorResponse(reply, 404, 'Usuario no encontrado');
        }

        const fileName = `profile_${phone_number}_${Date.now()}.jpg`;
        const uploadResult = await processAndUploadImage(image_url, fileName);

        if (uploadResult.success) {
            user.photo = uploadResult.ipfs_url ?? '';
            await user.save();

            console.log('Image uploaded successfully:', uploadResult);
            return await returnSuccessResponse(reply, 'Imagen subida exitosamente', {
                icp_url: uploadResult.icp_url,
                ipfs_url: uploadResult.ipfs_url,
            });
        }

        console.error('Error uploading image:', uploadResult.error);
        return await returnErrorResponse(reply, 500, 'Error uploading image', uploadResult.error);
    } catch (error) {
        console.error('Error uploading image:', error);
        return returnErrorResponse(reply, 500, 'Error interno del servidor');
    }
};
