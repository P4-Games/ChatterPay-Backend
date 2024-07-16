import sys
import os
from pathlib import Path
from dotenv import load_dotenv

# Añade el directorio raíz del proyecto al PYTHONPATH
root_dir = Path(__file__).parent
sys.path.insert(0, str(root_dir))

# Carga las variables de entorno del archivo .env.test
load_dotenv(root_dir / '.env.test')