# Hackathon Ethereum 2024 - ChatterPay

ChatterPay es una billetera crypto en WhatsApp que integra IA y Abstracción de Cuentas, permitiendo a cualquier usuario utilizar blockchain de forma fácil y segura sin necesidad de conocimientos técnicos.

Este proyecto es un backend utilizando TypeScript y Bun.js con el framework Fastify.

## Requisitos previos

- [Bun](https://bun.sh/)
- [Git](https://git-scm.com/)

## Inicialización del repositorio

Clona este repositorio:

```bash
   git clone https://github.com/P4-Games/ChatterPay-Backend
   cd ChatterPay-Backend
```

## Instalación de dependencias

Instala las dependencias necesarias con los siguientes comandos:

```bash
bun install
```

## Estructura de carpetas

- `src/`:
  - `controllers/`: Lógica de controladores.
  - `models/`: Definiciones de modelos de datos.
  - `routes/`: Definiciones de rutas.
  - `services/`: Lógica de negocio.
  - `utils/`: Funciones de utilidad.
  - `index.ts`: Punto de entrada de la aplicación.
- `tests/`: Directorio para pruebas.
- `config/`: Archivos de configuración.
- `.gitignore`: Especifica archivos y directorios ignorados por Git.
- `package.json`: Configuración del proyecto y dependencias.
- `tsconfig.json`: Configuración de TypeScript.
- `README.md`: Este archivo.
- `.env`: Variables de entorno.

## Ejecución del servidor

Para iniciar el servidor, ejecuta:

```bash
bun run src/index.ts
```

El servidor estará disponible en `http://localhost:3000`.

## Comentarios y documentación

- Utilizamos JSDoc para documentar nuestras funciones y clases.
- Asegúrate de mantener los comentarios actualizados a medida que el código cambia.
