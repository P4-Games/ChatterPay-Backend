import { FastifyReply, FastifyRequest, RouteHandlerMethod } from 'fastify';

import { User } from '../models/user';
import { authenticate } from './transactionController';
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
        authenticate(request);

        const { phone_number, image_url } = request.body as UploadBody;

        if (!phone_number) {
            return await reply.status(400).send({ message: 'Número de teléfono no proporcionado' });
        }

        if (!image_url) {
            return await reply.status(400).send({ message: 'URL de imagen no proporcionada' });
        }

        const user = await User.findOne({ phone_number });
        if (!user) {
            return await reply.status(404).send({ message: 'Usuario no encontrado' });
        }

        const fileName = `profile_${phone_number}_${Date.now()}.jpg`;
        const uploadResult = await processAndUploadImage(image_url, fileName);

        if (uploadResult.success) {
            user.photo = uploadResult.ipfs_url ?? '';
            await user.save();

            return await reply.status(200).send({
                message: 'Imagen subida exitosamente',
                icp_url: uploadResult.icp_url,
                ipfs_url: uploadResult.ipfs_url,
            });
        }
        return await reply.status(500).send({
            message: 'Error al subir imagen',
            error: uploadResult.error,
        });
    } catch (error) {
        console.error('Error en uploadImage:', error);
        return reply.status(500).send({ message: 'Error interno del servidor' });
    }
};
