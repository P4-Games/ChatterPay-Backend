//
// set MONGO_URI in env, then:
// bun run scripts/update_users_notif_language.ts
//
import dotenv from 'dotenv';
import mongoose from 'mongoose';

import { Logger } from '../src/helpers/loggerHelper';

dotenv.config();

// Configuración de la URI de MongoDB y otros detalles
const MONGO_URI: string = process.env.MONGO_URI || 'mongodb://localhost:27017/your_database';
const DB_NAME: string = 'chatterpay-dev';
const COLLECTION_NAME: string = 'users';

// Definición del esquema de usuario
const userSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone_number: String,
    photo: String,
    wallet: String,
    code: { type: String, default: null },
    settings: {
      notifications: {
        language: { type: String, default: 'es' }
      }
    }
  },
  { collection: COLLECTION_NAME }
);

// Creación del modelo de usuario
const User = mongoose.model('User', userSchema);

async function addSettingsField(): Promise<void> {
  try {
    // Conectar a la base de datos usando Mongoose
    await mongoose.connect(MONGO_URI, { dbName: DB_NAME });
    Logger.log('Conectado a la base de datos');

    // Actualizar documentos que no tienen el campo 'settings'
    const updateResult = await User.updateMany(
      { settings: { $exists: false } },
      {
        $set: {
          settings: {
            notifications: {
              language: 'es'
            }
          }
        }
      }
    );

    Logger.log(`Se actualizaron ${updateResult.modifiedCount} documentos.`);
  } catch (error) {
    Logger.error('Error actualizando documentos:', error);
  } finally {
    // Cerrar la conexión a la base de datos
    await mongoose.disconnect();
    Logger.log('Conexión cerrada');
  }
}

addSettingsField();
