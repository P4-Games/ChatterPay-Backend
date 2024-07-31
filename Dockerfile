# Usa la imagen oficial de Bun
FROM oven/bun:1

# Establece el directorio de trabajo en el contenedor
WORKDIR /app

# Copia los archivos de configuración del proyecto
COPY package.json bun.lockb tsconfig.json ./

# Instala las dependencias
RUN bun install --frozen-lockfile

# Copia el código fuente
COPY src ./src

# Expone el puerto en el que se ejecuta la aplicación
EXPOSE 3000

# Comando para ejecutar la aplicación
CMD ["bun", "start"]