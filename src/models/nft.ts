import { model, Schema, Document } from 'mongoose';

// Interfaz que representa el documento en la colección 'nfts'

export interface INFTMetadata {
    image_url: {
        gcp?: string;
        icp?: string;
        ipfs?: string;
    };
    description: string;
    geolocation?: {
        latitud: string;
        longitud: string;
    };
}

export interface INFT extends Document {
    channel_user_id: string;
    id: string;
    wallet: string;
    trxId: string;
    timestamp: Date;
    original: boolean;
    total_of_this: number;
    copy_of?: string;
    copy_order: number;
    copy_of_original?: string | null;
    copy_order_original: number;
    metadata: INFTMetadata;
}

// Definir el esquema de Mongoose
const NFTSchema = new Schema<INFT>({
    channel_user_id: { type: String, required: true },
    id: { type: String, required: true },
    wallet: { type: String, required: true },
    trxId: { type: String, required: true },
    timestamp: { type: Date, required: true },
    original: { type: Boolean, required: true },
    total_of_this: { type: Number, required: true },
    copy_of: { type: String, required: false },
    copy_order: { type: Number, required: true },
    copy_of_original: { type: String, required: false },
    copy_order_original: { type: Number, required: true },
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
                    longitud: { type: String, required: false },
                    latitud: { type: String, required: false },
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
