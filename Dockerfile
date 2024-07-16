# Usa una imagen base oficial de Python
FROM python:3.9-slim-buster

# Establece el directorio de trabajo en el contenedor
WORKDIR /app

# Copia los archivos de requisitos primero para aprovechar la caché de Docker
COPY requirements.txt .

# Instala las dependencias
RUN pip install --no-cache-dir -r requirements.txt

# Copia el resto del código de la aplicación
COPY . .

# Hace que el puerto 8000 esté disponible para el mundo fuera de este contenedor
EXPOSE 8000

# Ejecuta la aplicación cuando se inicie el contenedor
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port 8000"]