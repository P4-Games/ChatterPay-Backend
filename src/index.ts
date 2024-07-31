import Fastify from 'fastify';
import mongoose from 'mongoose';
import transactionRoutes from './routes/transactionRoutes';
import userRoutes from './routes/userRoutes';
import tokenRoutes from './routes/tokenRoutes';
import blockchainRoutes from './routes/blockchainRoutes';

// Crear una instancia de Fastify
const server = Fastify();
const PORT = process.env.PORT || 3000;
const MongoURI = process.env.MONGO_URI || 'mongodb://localhost:27017/chatterpay'

// Conectar a MongoDB
mongoose.connect(MongoURI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.error('MongoDB connection error:', err));

// Registrar las rutas
server.register(transactionRoutes);
server.register(userRoutes);
server.register(tokenRoutes)
server.register(blockchainRoutes)

// Iniciar el servidor
server.listen({ port: Number(PORT), host: '0.0.0.0' }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});
