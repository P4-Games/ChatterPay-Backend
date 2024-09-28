import { model, Schema, Document } from 'mongoose';

// Interfaz que representa el documento en la colección 'nfts'
export interface INFT extends Document {
    channel_user_id: string;
    id: number;
    wallet: string;
    trxId: string;
    copy_of?: number;
    original?: boolean;
    timestamp?: Date;
    metadata: {
        image_url: {
            gcp?: string;
            icp?: string;
            ipfs?: string;
        };
        description: string;
        geolocation?: {
            longitud: string;
            latitud: string;
        };
    };
}

// Definir el esquema de Mongoose
const NFTSchema = new Schema<INFT>({
    channel_user_id: { type: String, required: true },
    id: { type: Number, required: true },
    wallet: { type: String, required: true },
    trxId: { type: String, required: true },
    metadata: {
        image_url: {
            type: new Schema(
                {
                    gcp: { type: String, required: false },
                    icp: { type: String, required: false },
                    ipfs: { type: String, required: false },
                },
                { _id: false },
            ),
            required: true,
        },
        description: { type: String, required: true },
        geolocation: {
            type: new Schema(
                {
                    longitud: { type: String, required: true },
                    latitud: { type: String, required: true },
                },
                { _id: false },
            ),
            required: false,
        },
    },
});

// Crear el modelo basado en el esquema
const NFTModel = model<INFT>('NFTs', NFTSchema, 'nfts');

/**
 * Función para obtener el último ID (el ID más grande) en la colección 'nfts'
 * @returns {Promise<number>} El último ID
 */
export async function getLastId(): Promise<number> {
    try {
        const lastNFT = await NFTModel.findOne().sort({ id: -1 }).exec();
        return lastNFT ? lastNFT.id : 0; // Si no hay documentos, retorna 0
    } catch (error) {
        console.error('Error al obtener el último ID:', error);
        throw new Error('No se pudo obtener el último ID');
    }
}

export default NFTModel;
