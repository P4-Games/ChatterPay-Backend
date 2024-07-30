# Usa la imagen oficial de Bun
FROM oven/bun:1 as base

# Establece el directorio de trabajo en el contenedor
WORKDIR /app

# Copia los archivos de configuración del proyecto
COPY package.json bun.lockb tsconfig.json ./

# Instala las dependencias
RUN bun install --frozen-lockfile

# Copia el código fuente
COPY src ./src

# Compila el código TypeScript
RUN bun build ./src/index.ts --outdir ./dist

# Etapa de producción
FROM oven/bun:1-slim as production

WORKDIR /app

# Copia los archivos necesarios desde la etapa base
COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/package.json ./package.json

# Expone el puerto en el que se ejecuta la aplicación
EXPOSE 3000

# Comando para ejecutar la aplicación
CMD ["bun", "start"]