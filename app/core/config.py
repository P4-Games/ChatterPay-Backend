from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    PROJECT_NAME: str = "Multi-Chain Balance API"
    ALCHEMY_API_KEY: str

    class Config:
        env_file = ".env"

settings = Settings()