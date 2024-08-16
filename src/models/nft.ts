import { Schema, model, Document } from 'mongoose';

// Interfaz que representa el documento en la colección 'nft'
interface INFT extends Document {
  channel_user_id: string;
  id: number;
  trxId: string;
  metadata: {
    image_url: string;
    description: string;
  };
}

// Definir el esquema de Mongoose
const NFTSchema = new Schema<INFT>({
  channel_user_id: { type: String, required: true },
  id: { type: Number, required: true },
  trxId: { type: String, required: true },
  metadata: {
    image_url: { type: String, required: true },
    description: { type: String, required: true }
  }
});

// Crear el modelo basado en el esquema
const NFTModel = model<INFT>('NFTs', NFTSchema, 'nfts');

/**
 * Función para obtener el último ID (el ID más grande) en la colección 'nft'
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
