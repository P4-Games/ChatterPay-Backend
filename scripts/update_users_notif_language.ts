//
// set MONGO_URI in env, then:
// bun run scripts/update_users_notif_language.ts
// 
import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const MONGO_URI: string = process.env.MONGO_URI || "mongodb://localhost:27017/your_database";
const DB_NAME: string = "chatterpay-main";
const COLLECTION_NAME: string = "users";

interface User {
  _id: string;
  name: string;
  email: string;
  phone_number: string;
  photo: string;
  wallet: string;
  code: string | null;
  settings?: {
    notifications: {
      language: string;
    };
  };
}

async function addSettingsField(): Promise<void> {
  const client = new MongoClient(MONGO_URI);

  try {
    await client.connect();
    console.log("Conectado a la base de datos");

    const db = client.db(DB_NAME);
    const collection = db.collection<User>(COLLECTION_NAME);

    const updateResult = await collection.updateMany(
      { settings: { $exists: false } }, 
      {
        $set: {
          settings: {
            notifications: {
              language: "en",
            },
          },
        },
      }
    );

    console.log(`Se actualizaron ${updateResult.modifiedCount} documentos.`);
  } catch (error) {
    console.error("Error actualizando documentos:", error);
  } finally {
    await client.close();
    console.log("Conexión cerrada");
  }
}

addSettingsField();
